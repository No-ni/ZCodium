import { createSessionId, STREAM_RECOVERY_DISCARDED_ERROR_NAME } from "../deps.js";
import type { MessageWithParts, SessionId } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { formatLocalAgentTaskNotification } from "../../subagent/completion-notification.js";
import { readSubagentRunMetadata } from "../../subagent/runner.js";

const SUBAGENT_DISPATCH_TOOL_NAMES = new Set(["Agent", "Task"]);

const BACKGROUND_LAUNCH_ACK_PREFIX = "Async agent launched successfully.";

const PREVIOUS_RUNTIME_EXIT_REASON = "the ZCode runtime process exited before it finished";

// 只认 `<task-notification>` 块里的 task-id：无进展提醒（`<background-agent-stall>`）也带同一个
// task-id，但它不是终态通知，不能让崩溃前收到过提醒的 Agent 被当成「已通知」。
const TASK_NOTIFICATION_ID_PATTERN =
  /<task-notification>(?:(?!<\/task-notification>)[\s\S])*?<task-id>([^<]+)<\/task-id>/g;

/**
 * 上一代 runtime 进程退出时仍在后台运行、且没有交回结果的 Agent，汇总成给模型的提醒正文。
 *
 * 背景：同一个 workspace 的父会话与全部后台 Agent 跑在同一个进程里，进程崩溃（如系统内存耗尽）
 * 后 child 随之结束，却没有 task-notification；模型只看到「已在后台启动」，会一直等或自己排查。
 * 这里在父会话恢复时对账：launch ACK 早于本进程启动、本进程 registry 没有该任务、transcript
 * 里没有它的通知、输出目录的 metadata.json 仍是 running、child 在本进程启动后没有落盘、child 也
 * 没有终态——才判为被中断。
 *
 * 修复原因（!3562 评审 CR-01）：正常关闭时 runtime 会统一停止后台 Agent，失败的 Agent 也已有终态，
 * 只是通知在关闭或崩溃前没送达。最初只看「通知是否送达」，会把这些也报成「进程意外退出」，覆盖
 * 真实的停止者和错误原因。区分两者的持久化事实是 metadata.json：SubagentStopped 只在进程内存的
 * event store 里，新进程读不到。
 *
 * 通知按「最近一次运行」去重（!3562 评审第二轮 CR-02）：SendMessage 恢复沿用同一个 agentId，
 * 之前那次运行的完成通知还在 transcript 里；只有晚于 metadata.json 里 resumedAt 的通知才算这次
 * 运行已经通知过，否则恢复后的运行崩溃会被旧通知挡掉。
 * 正文沿用标准 local_agent 通知（status=failed），由下一轮请求前作为 task_status 提醒落盘送达；
 * 恢复本身不开新轮，打开旧会话不消耗 token，也不在内存仍紧张时立刻重新派发。
 */
export async function collectPreviousRuntimeAgentInterruptions(
  this: AgentRuntimeInternal,
  messages: readonly MessageWithParts[],
  runtimeStartedAt: number = performance.timeOrigin,
): Promise<string | undefined> {
  if (!this.sessionStore) return undefined;
  // taskId → 最近一条通知（含本对账自己落盘的提醒）的写入时间。
  const lastNotifiedAt = new Map<string, number>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "text") continue;
      for (const match of part.text.matchAll(TASK_NOTIFICATION_ID_PATTERN)) {
        const taskId = match[1]?.trim();
        if (!taskId) continue;
        lastNotifiedAt.set(
          taskId,
          Math.max(lastNotifiedAt.get(taskId) ?? 0, message.info.time.created),
        );
      }
    }
  }

  const notifications: string[] = [];
  for (const message of messages) {
    if (message.info.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part.type !== "tool" || !SUBAGENT_DISPATCH_TOOL_NAMES.has(part.tool)) continue;
      if (part.state.status !== "completed") continue;
      const output = part.state.output;
      if (typeof output !== "string" || !output.startsWith(BACKGROUND_LAUNCH_ACK_PREFIX)) continue;
      const agentId = output.match(/(?:^|\n)agentId:\s*([^\s(]+)/)?.[1];
      if (!agentId || part.state.time.start >= runtimeStartedAt) continue;
      if (this.runtimeTaskRegistry.get(agentId)) continue;
      // 取到行尾：Windows 的用户目录可能带空格。
      const outputFile = output.match(/(?:^|\n)output_file:[ \t]*([^\r\n]+)/)?.[1]?.trim();
      // 已写下终态（完成、失败、被停止，含正常关闭时的统一停止）：不是被崩溃中断的。
      // 读不到 metadata.json（旧版本、目录被清理）时退回下面按 child 会话判断。
      const run = await readSubagentRunMetadata({
        agentId,
        outputFile,
        outputRootDir: this.config.subagents?.outputRootDir,
        parentSessionId: this.sessionId,
      });
      // 已通知过：通知晚于最近一次恢复（没有恢复记录时任何通知都算）。
      const notifiedAt = lastNotifiedAt.get(agentId);
      if (
        notifiedAt !== undefined &&
        (run?.resumedAt === undefined || notifiedAt >= run.resumedAt)
      ) {
        continue;
      }
      if (run !== undefined && run.status !== "running") continue;
      const metadata = { ...(part.metadata ?? {}), ...(part.state.metadata ?? {}) } as Record<
        string,
        unknown
      >;
      const childSessionId =
        typeof metadata.childSessionId === "string"
          ? metadata.childSessionId
          : createSessionId(`subagent_${agentId}`);
      const child = await this.sessionStore.getSession(childSessionId as SessionId);
      // child 在本进程启动后仍有落盘：另一个进程正在运行它，不是遗留。
      if (!child || child.time.updated >= runtimeStartedAt) continue;
      if (childHasTerminalOutcome(await this.sessionStore.messages({ sessionID: child.id }))) {
        continue;
      }
      const input = part.state.input as Record<string, unknown>;
      notifications.push(
        formatLocalAgentTaskNotification({
          agentId,
          description:
            typeof input.description === "string" && input.description.trim()
              ? input.description
              : "Subagent",
          error: PREVIOUS_RUNTIME_EXIT_REASON,
          outputFile: outputFile ?? "",
          parentToolCallId: part.callID,
          status: "failed",
        }),
      );
    }
  }
  if (notifications.length === 0) return undefined;
  return [
    "The previous ZCode runtime process for this workspace exited unexpectedly (for example, because the system ran out of memory).",
    `${notifications.length === 1 ? "This background agent was" : "These background agents were"} still running and stopped with it. ${notifications.length === 1 ? "It" : "They"} will not report back.`,
    "Before relaunching, check what each agent already changed, then decide whether the work still needs to run. Tell the user if they are waiting on it.",
    "",
    ...notifications,
  ].join("\n");
}

/**
 * 与 sessions 查询（subagent-session-query.ts 的 lastChildOutcome）同一判据：最后一条 assistant
 * 带错误（失败、取消），或不含工具调用且已完成，就是终态。stream recovery 作废的半截回复不算，
 * 子会话会从锚点重发。进程崩溃时最后一条停在工具调用或流式输出中，没有错误也没有完成标记。
 */
function childHasTerminalOutcome(messages: readonly MessageWithParts[]): boolean {
  const last = messages.findLast((message) => message.info.role === "assistant");
  if (!last || last.info.role !== "assistant") return false;
  if (last.info.error) return last.info.error.name !== STREAM_RECOVERY_DISCARDED_ERROR_NAME;
  if (last.parts.some((part) => part.type === "tool")) return false;
  return Boolean(last.info.time.completed || last.info.finish);
}
export {
  SUBAGENT_DISPATCH_TOOL_NAMES,
  BACKGROUND_LAUNCH_ACK_PREFIX,
  PREVIOUS_RUNTIME_EXIT_REASON,
  TASK_NOTIFICATION_ID_PATTERN,
  childHasTerminalOutcome,
};
