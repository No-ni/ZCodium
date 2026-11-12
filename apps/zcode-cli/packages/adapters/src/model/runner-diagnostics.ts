import type { LanguageModelUsage } from "ai";
import type { Logger, ModelUsage } from "@zcode/contracts";
import { ModelFailureReason as ModelFailureReasonValue } from "@zcode/contracts";
import { isSuspiciousModelCompletion } from "./model-completion-policy.js";
export {
  createEmptyContextExceededError,
  isZeroOutputModelCompletion,
} from "./model-completion-policy.js";
import type { ClassifiedModelFailure } from "./failure-classifier.js";
import type { AiSdkGenerateTextResult } from "./runner-runtime.js";
import { normalizeUsageFromSteps } from "./runner-normalization.js";
import { mergePartialStreamUsage } from "./stream-usage/index.js";
import { asRecord, stringProperty } from "./runner-record.js";
import { modelStatusContextToLogContext, type ModelStatusContext } from "./runner-status.js";

type GenerateTextResultWithMetadata = AiSdkGenerateTextResult & {
  request?: { body?: unknown };
  response?: {
    body?: unknown;
    headers?: Record<string, string>;
    id?: string;
    messages?: unknown[];
    modelId?: string;
    timestamp?: Date;
  };
  steps?: unknown[];
};

interface StreamDiagnostics {
  chunkCounts: Record<string, number>;
  errorChunkCount: number;
  finishReason?: string;
  lastChunkType?: string;
  lastErrorChunk?: unknown;
  lastFinishChunk?: unknown;
  rawFinishReason?: unknown;
  reasoningDeltaChars: number;
  hasReasoningContent: boolean;
  textDeltaChars: number;
  toolCallCount: number;
  stepUsages: Array<Partial<LanguageModelUsage> | undefined>;
  partialUsage?: Partial<LanguageModelUsage>;
  usage?: ModelUsage;
}

export function createStreamDiagnostics(): StreamDiagnostics {
  return {
    chunkCounts: {},
    errorChunkCount: 0,
    reasoningDeltaChars: 0,
    hasReasoningContent: false,
    textDeltaChars: 0,
    toolCallCount: 0,
    stepUsages: [],
  };
}

export function recordStreamChunkDiagnostic(
  diagnostics: StreamDiagnostics,
  chunk: unknown,
  providerKind?: string,
): void {
  const record = asRecord(chunk);
  const chunkType = safeChunkType(record.type);
  diagnostics.lastChunkType = chunkType;
  diagnostics.chunkCounts[chunkType] = (diagnostics.chunkCounts[chunkType] ?? 0) + 1;

  if (chunkType === "start-step") {
    diagnostics.partialUsage = undefined;
    return;
  }
  if (chunkType === "raw") {
    diagnostics.partialUsage = mergePartialStreamUsage({
      previous: diagnostics.partialUsage,
      rawValue: record.rawValue,
      providerKind,
    });
    if (diagnostics.partialUsage)
      diagnostics.usage = normalizeUsageFromSteps(
        [...diagnostics.stepUsages, diagnostics.partialUsage],
        undefined,
        providerKind,
      );
    return;
  }

  if (chunkType === "text-delta") {
    diagnostics.textDeltaChars += stringProperty(record, "text")?.length ?? 0;
    return;
  }

  if (chunkType.startsWith("reasoning-")) {
    // 空文本可能携带有效的 reasoning 签名，不能当作空超窗丢弃。
    diagnostics.hasReasoningContent ||= Object.keys(asRecord(record.providerMetadata)).length > 0;
  }
  if (chunkType === "reasoning-delta") {
    diagnostics.reasoningDeltaChars += stringProperty(record, "text")?.length ?? 0;
    diagnostics.hasReasoningContent ||=
      (stringProperty(record, "delta") ?? stringProperty(record, "text") ?? "").length > 0;
    return;
  }

  if (chunkType === "tool-call") {
    diagnostics.toolCallCount += 1;
    return;
  }

  if (chunkType === "finish-step") {
    diagnostics.stepUsages.push(record.usage as Partial<LanguageModelUsage> | undefined);
    diagnostics.partialUsage = undefined;
    // 已报告 step 后仍可能断流；费用出口必须保留它，不能只等最终 finish。
    diagnostics.usage = normalizeUsageFromSteps(diagnostics.stepUsages, undefined, providerKind);
    return;
  }

  if (chunkType === "finish") {
    diagnostics.finishReason = stringProperty(record, "finishReason") ?? diagnostics.finishReason;
    diagnostics.rawFinishReason =
      record.rawFinishReason ?? asRecord(record.providerMetadata).rawFinishReason;
    diagnostics.lastFinishChunk = chunk;
    diagnostics.usage = normalizeUsageFromSteps(
      diagnostics.stepUsages,
      (record.totalUsage ?? record.usage) as Partial<LanguageModelUsage> | undefined,
      providerKind,
    );
    return;
  }

  if (chunkType === "error") {
    diagnostics.errorChunkCount += 1;
    diagnostics.lastErrorChunk = chunk;
  }
}

export function getGenerateTextResultMetadata(
  result?: AiSdkGenerateTextResult,
): GenerateTextResultWithMetadata | undefined {
  return result as GenerateTextResultWithMetadata | undefined;
}

export function logGenerateTextDiagnostics(input: {
  attempt: number;
  completedAt: number;
  logger?: Logger;
  result: AiSdkGenerateTextResult;
  startedAt: number;
  statusContext: ModelStatusContext;
  toolCallCount: number;
  usage: ModelUsage;
}): void {
  const textLength = input.result.text.length;
  const context = {
    ...modelStatusContextToLogContext(input.statusContext, input.attempt),
    durationMs: input.completedAt - input.startedAt,
    event: "model.sdk.generate.completed",
    finishReason: safeFinishReason(input.result.finishReason),
    module: "adapters.model",
    status: "completed" as const,
    textLength,
    toolCallCount: input.toolCallCount,
    ...summarizeModelUsage(input.usage),
  };

  input.logger?.info("AI SDK generateText resolved", context);
  if (
    isSuspiciousModelCompletion({
      finishReason: safeFinishReason(input.result.finishReason),
      textLength,
      toolCallCount: input.toolCallCount,
      usage: input.usage,
    })
  ) {
    input.logger?.warn("AI SDK generateText returned an empty non-stop result", {
      ...context,
      event: "model.sdk.generate.suspicious_empty",
    });
  }
}

export function logStreamDiagnostics(input: {
  attempt: number;
  diagnostics: StreamDiagnostics;
  durationMs: number;
  emittedError: boolean;
  emittedEvent: boolean;
  logger?: Logger;
  outboundHeaders?: Record<string, string>;
  statusContext: ModelStatusContext;
}): void {
  const context = {
    ...modelStatusContextToLogContext(input.statusContext, input.attempt),
    chunkCounts: input.diagnostics.chunkCounts,
    durationMs: input.durationMs,
    emittedError: input.emittedError,
    emittedEvent: input.emittedEvent,
    event: "model.sdk.stream.completed",
    errorChunkCount: input.diagnostics.errorChunkCount,
    finishReason: safeFinishReason(input.diagnostics.finishReason),
    lastChunkType: input.diagnostics.lastChunkType,
    module: "adapters.model",
    reasoningDeltaChars: input.diagnostics.reasoningDeltaChars,
    status: "completed" as const,
    textDeltaChars: input.diagnostics.textDeltaChars,
    toolCallCount: input.diagnostics.toolCallCount,
    ...summarizeModelUsage(input.diagnostics.usage),
  };

  input.logger?.info("AI SDK stream completed", context);
  if (
    isSuspiciousModelCompletion({
      finishReason: safeFinishReason(input.diagnostics.finishReason),
      textLength: input.diagnostics.textDeltaChars,
      toolCallCount: input.diagnostics.toolCallCount,
      usage: input.diagnostics.usage,
    })
  ) {
    input.logger?.warn("AI SDK stream returned an empty non-stop result", {
      ...context,
      event: "model.sdk.stream.suspicious_empty",
    });
  }
}

export function logStreamFailureDiagnostics(input: {
  attempt: number;
  canRetry: boolean;
  diagnostics: StreamDiagnostics;
  durationMs: number;
  emittedError: boolean;
  emittedEvent: boolean;
  emittedRetryBoundaryEvent: boolean;
  error: unknown;
  failure: ClassifiedModelFailure;
  logger?: Logger;
  statusContext: ModelStatusContext;
}): void {
  input.logger?.error("AI SDK stream failed", undefined, {
    ...modelStatusContextToLogContext(input.statusContext, input.attempt),
    chunkCounts: input.diagnostics.chunkCounts,
    durationMs: input.durationMs,
    emittedError: input.emittedError,
    emittedEvent: input.emittedEvent,
    emittedRetryBoundaryEvent: input.emittedRetryBoundaryEvent,
    errorAfterFinish: input.diagnostics.finishReason !== undefined,
    errorChunkCount: input.diagnostics.errorChunkCount,
    event: "model.sdk.stream.failed",
    finishReason: safeFinishReason(input.diagnostics.finishReason),
    lastChunkType: input.diagnostics.lastChunkType,
    module: "adapters.model",
    reason: input.failure.reason,
    reasoningDeltaChars: input.diagnostics.reasoningDeltaChars,
    retryable: input.canRetry,
    status: input.failure.reason === ModelFailureReasonValue.Cancelled ? "cancelled" : "failed",
    statusCode: input.failure.statusCode,
    textDeltaChars: input.diagnostics.textDeltaChars,
    toolCallCount: input.diagnostics.toolCallCount,
    ...summarizeModelUsage(input.diagnostics.usage),
  });
}

export function logIgnoredStreamChunk(input: {
  attempt: number;
  chunk: unknown;
  logger?: Logger;
  statusContext: ModelStatusContext;
}): void {
  input.logger?.debug("AI SDK stream chunk was ignored", {
    ...modelStatusContextToLogContext(input.statusContext, input.attempt),
    ...summarizeStreamChunk(input.chunk),
    event: "model.sdk.stream.chunk_ignored",
    module: "adapters.model",
    status: "completed",
  });
}

function summarizeStreamChunk(chunk: unknown): Record<string, unknown> {
  const record = asRecord(chunk);
  return {
    chunkType: safeChunkType(record.type),
    finishReason: safeFinishReason(record.finishReason),
  };
}

function summarizeModelUsage(usage?: ModelUsage): Record<string, unknown> | undefined {
  if (!usage) return undefined;
  return {
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    serverToolUse: usage.serverToolUse,
    totalTokens: usage.totalTokens,
  };
}

export function isSuspiciousStreamDiagnostics(diagnostics: StreamDiagnostics): boolean {
  return isSuspiciousModelCompletion({
    finishReason: diagnostics.finishReason,
    textLength: diagnostics.textDeltaChars,
    toolCallCount: diagnostics.toolCallCount,
    usage: diagnostics.usage,
  });
}

function safeChunkType(value: unknown): string {
  switch (value) {
    case "text-start":
    case "text-delta":
    case "text-end":
    case "reasoning-start":
    case "reasoning-delta":
    case "reasoning-end":
    case "tool-call":
    case "tool-result":
    case "tool-error":
    case "tool-input-start":
    case "tool-input-delta":
    case "tool-input-end":
    case "start":
    case "start-step":
    case "finish":
    case "finish-step":
    case "abort":
    case "error":
    case "raw":
    case "source":
    case "file":
      return value;
    default:
      return "other";
  }
}

function safeFinishReason(value: unknown): string {
  switch (value) {
    case "stop":
    case "length":
    case "content-filter":
    case "tool-calls":
    case "error":
    case "other":
    case "unknown":
      return value;
    default:
      return "unknown";
  }
}
