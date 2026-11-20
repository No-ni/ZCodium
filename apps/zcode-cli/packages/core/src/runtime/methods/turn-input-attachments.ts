import {
  appendRuntimeContextAnnouncements,
  appendRuntimeSkillsAnnouncement,
  persistAnnouncements,
} from "./context-refresh.js";
import { getTurnTools } from "./turn-tool-visibility.js";
import { appendRuntimeAgentListing } from "../helpers/agent-listing.js";
import { buildToolSearchAnnouncement } from "../../tool/search/exposure.js";
import { createMessageId } from "../deps.js";
import {
  buildRuntimeModeReminderBodyForTask,
  buildPlanModeExitReminderBody,
  buildRuntimeOutputStyleReminderBody,
  buildTodoReminderBody,
  buildSilentTurnReminderBody,
  shouldBuildTodoReminder,
} from "../helpers/index.js";
import {
  isRuntimeAttachmentEntry,
  systemReminderAttachmentEntry,
  todoReminderRuntimeMetadata,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { latestContextTokens, querySourceForTask } from "./turn-model-step-usage.js";
import { inputRoleOf } from "../helpers/provider-entry-origins.js";
import {
  consumeTotalTokensBudget,
  decideTotalTokensReminder,
  reanchorTotalTokensBudget,
  type InputAttachmentCollectionReason,
} from "../helpers/total-tokens-budget.js";
import { formatTotalTokensReminder } from "../../context/total-tokens.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import { consumePendingProjectMemoryUpdate } from "../helpers/project-memory-dream.js";
import { commitTurnRequestEntries } from "./turn-output-token-continuation.js";

/**
 * 新轮通知与 peer 消息开启的轮次，首个请求不收集输入附件。
 * 请求前公告不受影响，照常运行并在投影时冒泡到通知之前。只看历史判断，resume/fork/rewind 后
 * 自然一致；调用工具后最后一条变成 tool result，后续请求照常收集。
 */
function isNewTurnInput(latestMessage: RuntimeMessageEntry | undefined): boolean {
  return latestMessage !== undefined && inputRoleOf(latestMessage) === "new_turn";
}

/**
 * 输入附件收集，按固定顺序依次执行；各项保留自己的触发条件。
 * 全部写入历史，resume 后前缀不变。todo 提醒先提交再落盘，其余先持久化成功再提交。
 */
async function collectInputAttachments(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  tools: ReturnType<typeof getTurnTools>,
  reason: InputAttachmentCollectionReason,
  fromUser: boolean,
): Promise<void> {
  await appendRuntimeContextAnnouncements(
    runtime,
    state.turnRequestState,
    state.model,
    state.turnOutputStyle,
    state.turnTraceContext,
    state.turnAbortSignal,
  );
  // ToolSearch 公告（deferred tools 增量）在模型之后、agent listing 之前。
  await appendToolSearchAnnouncement(runtime, state, tools);
  await appendRuntimeAgentListing(runtime, state.turnRequestState, tools, state.turnTraceContext);
  await appendRuntimeSkillsAnnouncement(runtime, state.turnRequestState, state.turnTraceContext);
  // 上一代 runtime 退出时中断的后台 Agent：恢复时只记下，随下一轮落盘送达（不为它单独开轮）。
  const previousRuntimeAgentNotice = runtime.pendingPreviousRuntimeAgentNotice;
  if (previousRuntimeAgentNotice) {
    await persistAnnouncements(
      runtime,
      state.turnRequestState,
      [systemReminderAttachmentEntry("task_status", previousRuntimeAgentNotice)],
      state.turnTraceContext,
    );
    runtime.pendingPreviousRuntimeAgentNotice = undefined;
  }
  // 退出提醒由历史推导（最近的 plan 提醒之后没有退出提醒），内存标记只是额外触发。
  // 修复原因：只看内存标记时，冷恢复后标记丢失，计划模式的退出提醒不会发出。
  if (
    !runtime.getPlanEnabled() &&
    (runtime.needsPlanModeExitReminder || isPlanModeExitPending(state.turnRequestState.entries))
  ) {
    await persistAnnouncements(
      runtime,
      state.turnRequestState,
      [systemReminderAttachmentEntry("plan_mode_exit", buildPlanModeExitReminderBody())],
      state.turnTraceContext,
    );
    runtime.needsPlanModeExitReminder = false;
  }
  const runtimeModeReminderBody = buildRuntimeModeReminderBodyForTask(
    state.turnRequestState.entries,
    {
      mode: runtime.getMode(),
      planEnabled: runtime.getPlanEnabled(),
      taskType: runtime.config.taskType,
      tools,
    },
  );
  if (runtimeModeReminderBody) {
    // 只写内存会在冷恢复时丢失提醒与计数边界；复用动态公告的持久化和 hydration。
    await persistAnnouncements(
      runtime,
      state.turnRequestState,
      [systemReminderAttachmentEntry("runtime_mode", runtimeModeReminderBody)],
      state.turnTraceContext,
    );
  }
  if (
    tools.some((tool) => tool.name === "TodoWrite") &&
    shouldBuildTodoReminder(state.turnRequestState.entries)
  ) {
    const currentTodos = await runtime.readSessionTodosForContext(state.turnTraceContext);
    const reminderBody = buildTodoReminderBody(currentTodos);
    commitTurnRequestEntries(runtime, state.turnRequestState, [
      systemReminderAttachmentEntry("todo_reminder", reminderBody),
    ]);
    await runtime.persistSyntheticUserNoticeForSession({
      messageID: createMessageId(),
      metadata: { runtimeMessage: todoReminderRuntimeMetadata() },
      sessionId: runtime.sessionId,
      source: "todo_reminder",
      text: reminderBody,
      traceContext: state.turnTraceContext,
    });
  }
  const silentReminderBody =
    state.modelStepCount > 0 && querySourceForTask(runtime.config.taskType) === "main_turn"
      ? buildSilentTurnReminderBody(state.turnRequestState.entries)
      : null;
  if (silentReminderBody) {
    // 历史是计数的唯一来源；先持久化再提交，避免失败后留下已提醒的虚假标记。
    await persistAnnouncements(
      runtime,
      state.turnRequestState,
      [systemReminderAttachmentEntry("silent_turn_reminder", silentReminderBody)],
      state.turnTraceContext,
    );
  }
  await appendTotalTokensReminder(runtime, state, reason, fromUser);
  // （2026-09-12）：原"回合开始注入 plugin_ui_state reminder"已删除，插件给模型的信息
  // 一律走 ui/update-model-context。
  // output_style 每次收集都产出，不去重。修复原因：只在首步发且不落 session 时，
  // 工具批次后的请求缺少它，resume 后的前缀也会变化。
  const outputStyleReminderBody = buildRuntimeOutputStyleReminderBody(state.turnOutputStyle);
  // Dream 可能在同一 turn 的首个模型请求期间完成；每次收集都检查，把一次性更新放进紧随其后的请求。
  // 修复原因：作为只属于单次请求的 entry 时，后续请求缺少它，同一会话内的请求前缀因此变化。
  const pendingMemoryUpdate = runtime.pendingMemoryUpdate;
  const memoryUpdate = consumePendingProjectMemoryUpdate(runtime);
  try {
    await persistAnnouncements(
      runtime,
      state.turnRequestState,
      [
        ...(outputStyleReminderBody
          ? [systemReminderAttachmentEntry("output_style", outputStyleReminderBody)]
          : []),
        ...(memoryUpdate ? [memoryUpdate] : []),
      ],
      state.turnTraceContext,
    );
  } catch (error) {
    // 修复原因：更新先取出再写库，写库失败时这条一次性更新会永久丢失。
    // 放回去由下一次收集再发；期间 Dream 产生了更新的版本时保留新的。
    runtime.pendingMemoryUpdate ??= pendingMemoryUpdate;
    throw error;
  }
  // UserPromptSubmit 的上下文是本轮输入附件批次的最后一项，在请求前公告之前；只在本轮第一次收集时写入。
  // 新轮通知跳过首次收集，但这类轮次不运行 UserPromptSubmit，所以不会被推迟。
  if (state.userPromptHookContext) {
    await persistAnnouncements(
      runtime,
      state.turnRequestState,
      [state.userPromptHookContext],
      state.turnTraceContext,
    );
    state.userPromptHookContext = undefined;
  }
}

/**
 * token 预算倒数：数值来自 runtime 计数器与最近一条带 usage 的 assistant。
 * 先写库再提交并更新计数器；写库失败时计数器保持原值，错误向上冒泡。
 */
async function appendTotalTokensReminder(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  reason: InputAttachmentCollectionReason,
  fromUser: boolean,
): Promise<void> {
  const entries = state.turnRequestState.entries;
  const decision = decideTotalTokensReminder({
    reason,
    mainSession: querySourceForTask(runtime.config.taskType) === "main_turn",
    fromUser,
  });
  if (!decision.emit) return;
  const context = latestContextTokens(entries);
  const budget = decision.reanchor
    ? reanchorTotalTokensBudget(runtime.totalTokensBudget, context)
    : runtime.totalTokensBudget;
  const consumed = consumeTotalTokensBudget(budget, context);
  await persistAnnouncements(
    runtime,
    state.turnRequestState,
    [
      systemReminderAttachmentEntry(
        "total_tokens_reminder",
        formatTotalTokensReminder(consumed.remaining),
      ),
    ],
    state.turnTraceContext,
  );
  runtime.totalTokensBudget = consumed.state;
}

async function appendToolSearchAnnouncement(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  tools: ReturnType<typeof getTurnTools>,
): Promise<void> {
  const announcement = buildToolSearchAnnouncement({
    model: state.model,
    mode: runtime.config.toolSearch?.mode,
    tools,
    registry: runtime.getToolRegistry(),
    entries: state.turnRequestState.entries,
  });
  // 公告正文和增量事实必须先一起落盘；否则 fork/resume 会把已公告工具重新当成首次出现。
  await persistAnnouncements(
    runtime,
    state.turnRequestState,
    announcement ? [announcement] : [],
    state.turnTraceContext,
    state.model,
  );
}

function isPlanModeExitPending(entries: readonly RuntimeMessageEntry[]): boolean {
  const latest = entries.findLast(
    (entry) =>
      isRuntimeAttachmentEntry(entry) &&
      (entry.metadata.source === "runtime_mode" || entry.metadata.source === "plan_mode_exit"),
  );
  return latest?.metadata?.source === "runtime_mode";
}
export {
  isNewTurnInput,
  collectInputAttachments,
  appendTotalTokensReminder,
  appendToolSearchAnnouncement,
  isPlanModeExitPending,
};
