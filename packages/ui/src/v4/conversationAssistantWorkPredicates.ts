import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { type ToolCallRowDerivationResolver } from "@/v4/conversationAssistantWorkItemDerivation.js";
import type { AssistantWorkRow } from "@/v4/conversationTurnRenderUnits.js";

const SUBAGENT_TOOL_NAMES = new Set(["Agent", "Task", "subagent"]);

const isToolCallRow = (row: AssistantWorkRow): row is ToolCallRow => row.kind === "toolCall";

const isAgentToolCallRow = (row: AssistantWorkRow): row is ToolCallRow =>
  isToolCallRow(row) && SUBAGENT_TOOL_NAMES.has(row.toolName);

function isExploreToolCallRow(
  row: AssistantWorkRow,
  derive: ToolCallRowDerivationResolver,
): row is ToolCallRow {
  return derive(row)?.isExplore === true;
}

function isExecuteToolCallRow(
  row: AssistantWorkRow,
  derive: ToolCallRowDerivationResolver,
): row is ToolCallRow {
  return derive(row)?.isExecute === true;
}

function isChangesToolCallRow(
  row: AssistantWorkRow,
  derive: ToolCallRowDerivationResolver,
): row is ToolCallRow {
  return derive(row)?.isChanges === true;
}

function shouldDeferUnclassifiedShellToolCall(
  row: AssistantWorkRow,
  derive: ToolCallRowDerivationResolver,
): boolean {
  if (!isToolCallRow(row) || (row.status !== "inputStreaming" && row.status !== "running")) {
    return false;
  }
  return derive(row)?.awaitingCommand === true;
}

function resolveGroupStageStatus(
  rows: readonly ToolCallRow[],
  stageTailIsRunning: boolean,
): string {
  // Explore/Execute 父节点表达的是当前工作阶段，不是子工具执行状态的汇总。
  // 子工具可能已经全部完成，但只要当前运行工作段尚未出现下一条可见边界，父阶段仍在继续；
  // 反之，后续非当前分组内容已经出现时，即使迟到的子状态仍是 running，父阶段也必须结束。
  if (stageTailIsRunning) return "in_progress";
  return rows.some((row) => row.status === "cancelled") ? "stopped" : "completed";
}
export {
  SUBAGENT_TOOL_NAMES,
  isToolCallRow,
  isAgentToolCallRow,
  isExploreToolCallRow,
  isExecuteToolCallRow,
  isChangesToolCallRow,
  shouldDeferUnclassifiedShellToolCall,
  resolveGroupStageStatus,
};
