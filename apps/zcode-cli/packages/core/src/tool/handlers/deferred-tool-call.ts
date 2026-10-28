import { z } from "zod";
import {
  DEFERRED_TOOL_CALL_NAME,
  DeferredToolCallInputJsonSchema,
  DeferredToolCallInputSchema,
} from "@zcode/contracts";
import type { ToolEntry } from "../types.js";

const MAX_CONTROL_RESULT_BYTES = 100_000;
export const deferredToolCallEntry: ToolEntry = {
  capability: "Call a deferred tool through the existing executor",
  metadata: {
    name: DEFERRED_TOOL_CALL_NAME,
    description:
      "Call one deferred tool with its exact name and input object after loading its complete definition with ToolSearch. Call resident tools directly. Normal target hooks and permissions apply.",
    // 调度与权限前解包，真正的只读/并发/副作用属性由目标声明决定。
    readOnly: false,
    concurrentSafe: false,
    destructive: false,
    sideEffectScope: "system",
    riskLevel: "high",
    needsApproval: true,
    alwaysLoad: true,
  },
  inputSchema: DeferredToolCallInputJsonSchema,
  runtimeInputSchema: DeferredToolCallInputSchema,
  outputSchema: {},
  runtimeOutputSchema: z.unknown(),
  permission: {
    permission: "tool.deferred_call",
    reason: "Call a deferred tool",
    riskLevel: "high",
    sideEffectScope: "system",
    needsApproval: true,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  timeout: { kind: "none" },
  cancellation: { supported: true, cleanup: "none", userVisibleMessage: "Tool call cancelled" },
  resultBudget: {
    maxInlineBytes: MAX_CONTROL_RESULT_BYTES,
    maxModelBytes: MAX_CONTROL_RESULT_BYTES,
    strategy: "truncate",
    preview: { direction: "head" },
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
  handler: async () => {
    throw new Error("DeferredToolCall must be resolved before tool execution.");
  },
};
