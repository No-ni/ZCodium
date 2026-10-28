import { ModelErrorCode, type ModelUsage } from "@zcode/contracts";
import { AiSdkModelAdapterError } from "./errors.js";

const CONTEXT_LIMIT_FINISH_REASONS = new Set([
  "context_exceeded", "context_length_exceeded", "context_window_exceeded",
  "model_context_exceeded", "model_context_window_exceeded", "prompt_too_long",
]);
const EMPTY_COMPLETION_RETRY_EXCLUSIONS = new Set([
  ...CONTEXT_LIMIT_FINISH_REASONS, "refusal", "content-filter", "content_filter",
]);

export function createEmptyContextExceededError(input: {
  finishReason?: string;
  rawFinishReason?: unknown;
  hasAssistantContent: boolean;
  toolCallCount: number;
  usage?: ModelUsage;
}): AiSdkModelAdapterError | undefined {
  // 超窗仅解释无有效输出的明确终态；partial 必须交回 Core，不能改变既有续写策略。
  if (input.hasAssistantContent || input.toolCallCount > 0) return undefined;
  if (![input.finishReason, input.rawFinishReason].some((reason) =>
    typeof reason === "string" && CONTEXT_LIMIT_FINISH_REASONS.has(reason.trim().toLowerCase()),
  )) return undefined;
  return new AiSdkModelAdapterError(
    ModelErrorCode.ModelContextExceeded,
    "Model request exceeded the provider context window.",
    { usage: input.usage },
  );
}

export function isZeroOutputModelCompletion(input: {
  finishReason?: string;
  rawFinishReason?: unknown;
  reasoningLength: number;
  textLength: number;
  toolCallCount: number;
  usage?: ModelUsage;
}): boolean {
  // 拒绝、过滤和超窗不是瞬态空响应，原样重试只会掩盖确定失败。
  if ([input.finishReason, input.rawFinishReason].some((reason) =>
    typeof reason === "string" && EMPTY_COMPLETION_RETRY_EXCLUSIONS.has(reason.trim().toLowerCase()),
  )) return false;
  return input.finishReason !== undefined && input.reasoningLength === 0 &&
    isSuspiciousModelCompletion(input);
}

export function isSuspiciousModelCompletion(input: {
  finishReason?: string;
  textLength: number;
  toolCallCount: number;
  usage?: ModelUsage;
}): boolean {
  const reason = input.finishReason?.trim().toLowerCase();
  return input.textLength === 0 && input.toolCallCount === 0 &&
    reason !== "stop" && reason !== "tool-calls" && reason !== "tool_calls" &&
    isZeroUsage(input.usage);
}

function isZeroUsage(usage?: ModelUsage): boolean {
  if (!usage) return true;
  if ((usage.serverToolUse?.webSearchRequests ?? 0) + (usage.serverToolUse?.webFetchRequests ?? 0) > 0)
    return false;
  return (usage.totalTokens ??
    (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.cacheReadTokens ?? 0) +
    (usage.cacheWriteTokens ?? 0) + (usage.reasoningTokens ?? 0)) === 0;
}
