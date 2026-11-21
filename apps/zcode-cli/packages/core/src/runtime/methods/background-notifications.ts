import { createMessageId, traceContextToLogContext } from "../deps.js";
import type { MessageId, TraceContext } from "../deps.js";
import type { BackgroundResultOriginMeta } from "@zcode/contracts";
import { createRuntimeCommandId, type TaskNotificationRuntimeCommand } from "../command-queue.js";
import { runtimeInputMetadata } from "../../agent/runtime-input-presentation.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { SealBackgroundTaskNotificationsInput } from "../types.js";
import { shouldSuppressSealedSubagentBashNotification } from "../../runtime-task/notification-policy.js";
import { joinTaskNotificationBatch } from "../../runtime-task/notification.js";
import { isBackgroundSubagentStallReminderCurrent } from "../../subagent/background-stall.js";
export { collectPreviousRuntimeAgentInterruptions } from "./background-notification-history.js";

export function enqueueBackgroundTaskNotification(
  this: AgentRuntimeInternal,
  notification: {
    originMeta?: BackgroundResultOriginMeta;
    taskId?: string;
    text: string;
    toolName?: string;
    traceContext: TraceContext;
  },
): void {
  if (this.shuttingDown) {
    // 防御直接调用路径：session teardown 期间只允许任务状态收口，不能再启动模型轮次。
    this.logger?.info?.("Dropped background task notification during runtime shutdown", {
      ...traceContextToLogContext(notification.traceContext),
      event: "runtime.background_task_notification.shutdown_dropped",
      module: "core.runtime",
      taskId: notification.taskId,
      toolName: notification.toolName,
    });
    return;
  }
  const task = notification.taskId ? this.runtimeTaskRegistry.get(notification.taskId) : undefined;
  const branchGeneration = task?.branchGeneration ?? this.branchGeneration;
  if (branchGeneration !== this.branchGeneration) {
    this.logger?.debug("Dropped stale-branch background task notification", {
      ...traceContextToLogContext(notification.traceContext),
      branchGeneration,
      currentBranchGeneration: this.branchGeneration,
      event: "runtime.background_task_notification.stale_branch_dropped",
      module: "core.runtime",
      taskId: notification.taskId,
    });
    return;
  }
  const commandId = createRuntimeCommandId();
  this.enqueueRuntimeCommand({
    branchGeneration,
    createdAt: new Date(),
    id: commandId,
    mode: "task-notification",
    priority: "next",
    source: "background_task",
    originMeta: notification.originMeta,
    taskId: notification.taskId,
    text: notification.text,
    toolName: notification.toolName,
    traceContext: notification.traceContext,
  });
  // wake 入账本（admitted）。runtime 命令队列是纯内存的，账本是唯一
  // durable 痕迹——崩溃重启后后台子进程已死、通知不可恢复，resume 会把残留
  // admitted 收口为 discarded(session_resumed)（留痕不静默，同一语义）。
  const admission = this.sessionStore?.saveSessionInput?.({
    id: String(commandId),
    sessionID: this.sessionId,
    kind: "backgroundNotification",
    delivery: "queue",
    payload: {
      text: notification.text,
      ...(notification.taskId ? { taskId: notification.taskId } : {}),
      ...(notification.originMeta ? { originMeta: notification.originMeta } : {}),
    },
  });
  if (admission) {
    rememberBackgroundNotificationAdmission(this, String(commandId), admission);
    void this.trackResidencyBlockingWork(admission).catch(() => {
      // 存储异常可能含原文，toString 也可能再抛错；故障日志只保留固定技术原因。
      this.logger?.warn("Failed to admit background notification to ledger", {
        ...traceContextToLogContext(notification.traceContext),
        reason: "storage_write_failed",
        event: "session_input.admit_failed",
        module: "core.runtime",
        status: "failed",
      });
    });
  }
}

export function sealBackgroundTaskNotifications(
  this: AgentRuntimeInternal,
  input: SealBackgroundTaskNotificationsInput,
): void {
  if (this.config.taskType !== "subagent_child") return;
  this.backgroundTaskNotificationsSealed = true;
  this.backgroundTaskNotificationSealReason = input.reason;
  this.logger?.info?.("Subagent runtime background task notifications sealed", {
    ...traceContextToLogContext(input.traceContext ?? this.rootTraceContext),
    event: "runtime.background_task_notifications.sealed",
    module: "core.runtime",
    reason: input.reason,
  });
}

export async function persistBackgroundTaskNotificationCommand(
  this: AgentRuntimeInternal,
  command: TaskNotificationRuntimeCommand,
): Promise<MessageId> {
  const persisted = await persistBackgroundTaskNotificationBatch.call(this, [command], true);
  return persisted.messageId;
}

export interface PersistedBackgroundTaskNotificationBatch {
  /** 仅整批来源一致时存在；混合/缺失来源不能从代表任务推断。 */
  backgroundSource?: BackgroundResultOriginMeta["backgroundSource"];
  messageId: MessageId;
  originMeta?: BackgroundResultOriginMeta;
  text: string;
}

const MAX_BACKGROUND_RESULT_TITLES = 3;

function resolveBackgroundTaskNotificationSource(
  commands: readonly [TaskNotificationRuntimeCommand, ...TaskNotificationRuntimeCommand[]],
): BackgroundResultOriginMeta["backgroundSource"] | undefined {
  // 无进展提醒不是后台结果：不让它把这一轮记成「由 subagent completion 唤起」
  // （message_source=background_subagent）。整批只有提醒时不带来源（!3563 评审 SG-01）。
  const results = commands.filter((command) => command.originMeta?.subagentStall === undefined);
  const source = results[0]?.originMeta?.backgroundSource;
  if (!source || results.some((command) => command.originMeta?.backgroundSource !== source)) {
    // 展示 metadata 只保留代表任务，不能把首项来源当作整批因果来源；
    // 混合或缺失来源留空，避免 notification 到达顺序改变 message_source。
    return undefined;
  }
  return source;
}

export function resolveBackgroundTaskNotificationOriginMeta(
  commands: readonly [TaskNotificationRuntimeCommand, ...TaskNotificationRuntimeCommand[]],
): BackgroundResultOriginMeta | undefined {
  // 单条：originMeta 整体透传，workflowNotification 载荷免费搭车（manifest 渲染的唯一数据源）。
  if (commands.length === 1) return commands[0].originMeta;

  const originMetas: BackgroundResultOriginMeta[] = [];
  for (const command of commands) {
    const originMeta = command.originMeta;
    if (!originMeta?.workId.trim() || !originMeta.title.trim()) return undefined;
    originMetas.push(originMeta);
  }

  const representative = originMetas[0];
  if (!representative) return undefined;
  const visibleTitles = originMetas
    .slice(0, MAX_BACKGROUND_RESULT_TITLES)
    .map((originMeta) => originMeta.title.trim());
  const remainingCount = originMetas.length - visibleTitles.length;
  const title = [...visibleTitles, ...(remainingCount > 0 ? [`+${remainingCount}`] : [])].join(
    " · ",
  );

  // 多 notification 共用一个 turn 后若直接丢弃 originMeta，后台结果会退化为
  // 普通 assistant 渲染。这里复用首个任务的展示锚点并只合成 title，不引入 batch schema。
  //
  // workflowNotification 载荷**刻意不合成**：manifest 是「一轮 ↔ 一张」的对应，批量下这条关系不成立——谎报第一条的
  // 载荷比整轮退化成裸标题行更坏。只保留 {backgroundSource, title, workId} 三个基字段，
  // 整轮据此退回现状标题行。
  return {
    backgroundSource: representative.backgroundSource,
    title,
    workId: representative.workId,
  };
}

const TASK_NOTIFICATION_OPEN = "<task-notification>";

/**
 * 标准 `<task-notification>` 排在前面，无进展提醒、workflow 运行中通知等其它正文排在后面（各自保持
 * 原有顺序）。修复原因：App 与 V4 产品投影只在整段输入以 `<task-notification>` 开头时才逐条解析
 * 终态；合批的第一条若是提醒，同批其它 Agent 的终态就不会更新到它们的工具行。
 * 展示用的 originMeta（标题顺序、代表任务的 workId）按同一顺序取，标题不会以「no progress」开头、
 * 而正文却先是终态。
 */
function orderTaskNotificationsForParsing(
  commands: readonly [TaskNotificationRuntimeCommand, ...TaskNotificationRuntimeCommand[]],
): [TaskNotificationRuntimeCommand, ...TaskNotificationRuntimeCommand[]] {
  const isNotification = (command: TaskNotificationRuntimeCommand) =>
    command.text.trimStart().startsWith(TASK_NOTIFICATION_OPEN);
  return [
    ...commands.filter(isNotification),
    ...commands.filter((command) => !isNotification(command)),
  ] as [TaskNotificationRuntimeCommand, ...TaskNotificationRuntimeCommand[]];
}

export async function persistBackgroundTaskNotificationBatch(
  this: AgentRuntimeInternal,
  commands: readonly [TaskNotificationRuntimeCommand, ...TaskNotificationRuntimeCommand[]],
  midTurn = false,
): Promise<PersistedBackgroundTaskNotificationBatch> {
  const firstCommand = commands[0];
  const backgroundSource = resolveBackgroundTaskNotificationSource(commands);
  const ordered = orderTaskNotificationsForParsing(commands);
  const originMeta = resolveBackgroundTaskNotificationOriginMeta(ordered);
  const texts = ordered.map((command) => command.text);
  // 这一轮的输入文本仍以 "\n\n" 相连，App 据此逐条解析任务卡片。
  const text = joinTaskNotificationBatch(texts);
  // 修复原因：整批原来存成一个连接字符串，投影时再按 <task-notification> 开头猜每条的边界；
  // workflow 运行中通知不以它开头，会被并进前一条通知的包装。空闲整批的每条通知改为同一条消息的
  // 一个文本块，模型看到的和冷恢复读回的都按块包装，边界不靠猜。轮中通知每条单独入队，不成批。
  const blocks = !midTurn && texts.length > 1 ? texts : undefined;
  await this.ensureContextInitialized(firstCommand.traceContext);
  const messageID = createMessageId();
  const inputPresentation = midTurn ? "task_notification_steer" : "task_notification";
  this.messageHistory.addUser(
    blocks ? blocks.map((block) => ({ type: "text" as const, text: block })) : text,
    runtimeInputMetadata(inputPresentation),
  );
  await this.persistSyntheticUserNoticeForSession({
    messageID,
    metadata: {
      inputPresentation,
      ...(originMeta ? { originMeta } : {}),
      visibility: "model-only",
    },
    sessionId: this.sessionId,
    source: "background_task",
    text: blocks ?? text,
    traceContext: firstCommand.traceContext,
    visibility: "model-only",
  });
  // outer drain 过去逐条持久化并逐条启动模型轮，pending 数量会线性放大
  // request 数。整批只写一条 synthetic message，同时仍逐项结算 ledger 身份。
  for (const command of commands) {
    await this.sessionStore
      ?.markSessionInputPromoted?.({
        id: String(command.id),
        sessionID: this.sessionId,
        promotedMessageID: messageID,
      })
      .catch(() => {
        this.logger?.warn("Failed to mark background notification promoted", {
          ...traceContextToLogContext(command.traceContext),
          commandId: command.id,
          reason: "storage_write_failed",
          event: "session_input.promote_mark_failed",
          module: "core.runtime",
          status: "failed",
        });
      });
  }
  return {
    ...(backgroundSource ? { backgroundSource } : {}),
    messageId: messageID,
    ...(originMeta ? { originMeta } : {}),
    text,
  };
}

/**
 * 入账（saveSessionInput）是异步的，出队丢弃时它可能还没写完：先等它，再结算，否则 settle 落空、
 * 随后写入的 admitted 永远留在账本里。按 runtime 记、入账完成后即删，不随会话增长。
 */
const backgroundNotificationAdmissions = new WeakMap<object, Map<string, Promise<unknown>>>();

function rememberBackgroundNotificationAdmission(
  runtime: AgentRuntimeInternal,
  commandId: string,
  admission: Promise<unknown>,
): void {
  let admissions = backgroundNotificationAdmissions.get(runtime);
  if (!admissions) {
    admissions = new Map();
    backgroundNotificationAdmissions.set(runtime, admissions);
  }
  const pending = admission.catch(() => undefined);
  admissions.set(commandId, pending);
  void pending.then(() => {
    if (admissions.get(commandId) === pending) admissions.delete(commandId);
  });
}

/**
 * 出队丢弃的通知要在账本里结算为 discarded（!3563 评审第四轮 CR-02）：内存命令已移除，留下的
 * admitted 会被会话常驻池当作未处理输入，挡住空闲时的插件自动重载，直到下次 resume 才收口。
 * 结算算作常驻阻塞工作，完成前不会误判空闲。
 */
function settleDroppedBackgroundNotification(
  runtime: AgentRuntimeInternal,
  command: TaskNotificationRuntimeCommand,
  reason: string,
): void {
  const settle = runtime.sessionStore?.settleSessionInput;
  if (!settle) return;
  const commandId = String(command.id);
  const work = (async () => {
    // 出队可能就发生在入队的同一同步片里（空闲时入队即开轮），那时 enqueue 还没调用
    // saveSessionInput：让出一个微任务，等入队同步片走完、入账登记好再取。
    await Promise.resolve();
    await backgroundNotificationAdmissions.get(runtime)?.get(commandId);
    await settle.call(runtime.sessionStore, {
      id: commandId,
      sessionID: runtime.sessionId,
      status: "discarded",
      reason,
    });
  })();
  const tracked = runtime.trackResidencyBlockingWork?.(work) ?? work;
  void tracked.catch(() => {
    runtime.logger?.warn("Failed to settle dropped background notification", {
      ...traceContextToLogContext(command.traceContext),
      commandId,
      failureReason: "storage_write_failed",
      event: "session_input.settle_failed",
      module: "core.runtime",
      reason,
      status: "failed",
    });
  });
}

export function shouldSuppressTaskNotificationRuntimeCommand(
  this: AgentRuntimeInternal,
  command: TaskNotificationRuntimeCommand,
): boolean {
  const registryTask = command.taskId ? this.runtimeTaskRegistry.get(command.taskId) : undefined;
  // 无进展提醒出队时已不成立（Agent 已结束、有新进展、在等审批或已恢复成新执行）：丢弃。
  // 终态通知会单独送达，模型不会先读到过时的「无进展」。
  const stall = command.originMeta?.subagentStall;
  if (stall !== undefined && !isBackgroundSubagentStallReminderCurrent(registryTask, stall)) {
    this.logger?.info?.("Dropped stale background subagent stall reminder", {
      ...traceContextToLogContext(command.traceContext),
      commandId: command.id,
      event: "runtime.background_task_notification.stall_reminder_stale",
      module: "core.runtime",
      taskId: command.taskId,
      taskStatus: registryTask?.status,
    });
    settleDroppedBackgroundNotification(this, command, "subagent_stall_reminder_stale");
    return true;
  }
  if (
    !shouldSuppressSealedSubagentBashNotification({
      isSubagentChildRuntime: this.config.taskType === "subagent_child",
      notificationSealed: this.backgroundTaskNotificationsSealed,
      registryTask,
      toolName: command.toolName,
    })
  ) {
    return false;
  }

  this.logger?.info?.("Suppressed sealed subagent background Bash notification", {
    ...traceContextToLogContext(command.traceContext),
    commandId: command.id,
    event: "runtime.background_task_notification.suppressed",
    module: "core.runtime",
    reason: this.backgroundTaskNotificationSealReason,
    taskId: command.taskId,
    toolName: command.toolName,
  });
  settleDroppedBackgroundNotification(this, command, "subagent_notifications_sealed");
  return true;
}
