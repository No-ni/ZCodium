import { isPlainRecord, readWorkflowScript } from "./createWorkflowInput.js";
import { isFillWorkflowHoleToolCall } from "../../lib/workflowToolNames.js";
import type { ToolCallCreateWorkflowDisplay } from "@zcode/shared/zcode-protocol-v4";

/** 只读 CLI resolveInput 的留白事实，不接受模型字段作为 owner/permission 判断。 */
export function readWorkflowFill(input: unknown):
  | {
      name: string;
      type?: string;
      draftPath?: string;
      line?: number;
    }
  | undefined {
  if (!isPlainRecord(input) || !isPlainRecord(input.hole)) return undefined;
  const hole = input.hole;
  if (typeof hole.name !== "string" || !hole.name.trim()) return undefined;
  return {
    name: hole.name,
    ...(typeof hole.type === "string" ? { type: hole.type } : {}),
    ...(typeof hole.draft_path === "string" ? { draftPath: hole.draft_path } : {}),
    ...(typeof hole.line === "number" && Number.isInteger(hole.line) && hole.line > 0
      ? { line: hole.line }
      : {}),
  };
}

/** 拼接属于 backend；script 是函数体，绝不能把它误标成完整工作流预览。 */
export function readWorkflowFillPreview(
  input: unknown,
): { script: string; complete: boolean } | undefined {
  if (isPlainRecord(input) && isPlainRecord(input.hole)) {
    const script = input.hole.effective_script;
    if (typeof script === "string" && script.length > 0) return { script, complete: true };
  }
  const script = readWorkflowScript(input);
  return script === undefined ? undefined : { script, complete: false };
}

/** 补全不启动新 run；同一输出面只换种类词与留白名，诊断/图的实现不复制。 */
export function readWorkflowFillPresentation(
  toolCall: {
    toolName?: string | null;
    kind?: string | null;
    title?: string | null;
    raw?: unknown;
    input?: unknown;
  },
  display: ToolCallCreateWorkflowDisplay | null,
  isRunning: boolean,
  failed: boolean,
): { name?: string; kind: string } | undefined {
  if (!isFillWorkflowHoleToolCall(toolCall)) return undefined;
  const name = display?.fill?.name ?? readWorkflowFill(toolCall.input)?.name;
  return {
    ...(name === undefined ? {} : { name }),
    kind: workflowFillKindMessageId({
      isRunning,
      failed,
      v4Status: isPlainRecord(toolCall.raw) ? toolCall.raw.v4Status : undefined,
    }),
  };
}

export function workflowFillKindMessageId(input: {
  isRunning: boolean;
  failed?: boolean;
  v4Status?: unknown;
}): string {
  if (input.failed) return "chat.toolCall.workflow.fill.failed";
  if (!input.isRunning) return "chat.toolCall.workflow.fill.done";
  if (input.v4Status === "pendingApproval")
    return "chat.toolCall.workflow.fill.awaitingConfirmation";
  return "chat.toolCall.workflow.fill.writing";
}
