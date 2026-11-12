import {
  CoreErrorType,
  SessionEventType,
  createModelUsageSummaryFromEvents,
  traceContextToLogContext,
} from "../deps.js";
import type { MessageId, SessionEvent, ToolCallId, TraceContext, TurnId } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import { isModelContextExceededError } from "../helpers/index.js";
import { errorInfoFor, firstModelTokenAt, modelNetworkEvents, usageStoreFor } from "./helpers.js";

interface RecordTurnUsageInput {
  completedAt: number;
  error?: unknown;
  events: readonly SessionEvent[];
  startedAt: number;
  status: "completed" | "error" | "cancelled";
  traceContext: TraceContext;
  turnId: TurnId;
  userMessageId?: MessageId;
}

export async function recordTurnUsageFact(
  runtime: AgentRuntimeInternal,
  input: RecordTurnUsageInput,
): Promise<void> {
  const usageStore = usageStoreFor(runtime);
  if (!usageStore) return;

  const usage = createModelUsageSummaryFromEvents(input.events);
  const modelRequests = input.events.filter(
    (event) => event.type === SessionEventType.ModelRequest,
  );
  const firstModelStartAt = modelRequests[0]?.timestamp.getTime();
  const firstTokenAt = firstModelTokenAt(input.events, 0);
  const toolScheduledIds = new Set<string>();
  const toolErrorIds = new Set<string>();
  for (const event of input.events) {
    if (event.type === SessionEventType.ToolCallScheduled) {
      const payload = event.payload as { toolCallId?: string };
      if (payload.toolCallId) toolScheduledIds.add(payload.toolCallId);
    }
    if (event.type === SessionEventType.ToolCallError) {
      const payload = event.payload as { toolCallId?: string };
      if (payload.toolCallId) toolErrorIds.add(payload.toolCallId);
    }
  }

  const errorInfo = errorInfoFor(input.error, undefined);
  const contextExceeded = isModelContextExceededError(input.error);

  try {
    await usageStore.upsertTurnUsage({
      sessionID: runtime.sessionId,
      turnID: input.turnId,
      traceID: input.traceContext.traceId,
      userMessageID: input.userMessageId,
      status: input.status,
      startedAt: input.startedAt,
      firstModelStartAt,
      firstTokenAt,
      completedAt: input.completedAt,
      durationMs: input.completedAt - input.startedAt,
      timeToFirstTokenMs: firstTokenAt === undefined ? undefined : firstTokenAt - input.startedAt,
      modelRequestCount: modelRequests.length,
      modelRetryCount: modelNetworkEvents(input.events).filter(
        (event) => event.type === "model_retry_scheduled",
      ).length,
      toolCallCount: toolScheduledIds.size,
      toolErrorCount: toolErrorIds.size,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      reasoningTokens: usage?.reasoningTokens,
      cacheCreationInputTokens: usage?.cacheWriteTokens,
      cacheReadInputTokens: usage?.cacheReadTokens,
      computedTotalTokens: usage?.totalTokens,
      retryable: errorInfo.retryable,
      cancelledByUser: input.status === "cancelled",
      contextExceeded,
      errorType: errorInfo.type,
      errorCode: errorInfo.code,
    });
  } catch {
    runtime.logger?.warn("Usage turn fact write failed", {
      ...traceContextToLogContext(input.traceContext),
      event: "usage.turn.write.failed",
      module: "core.runtime",
      status: "failed",
    });
  }
}

export async function recordToolUsageFromEvent(
  runtime: AgentRuntimeInternal,
  event: SessionEvent,
  traceContext: TraceContext,
): Promise<void> {
  const usageStore = usageStoreFor(runtime);
  if (!usageStore) return;

  const payload = event.payload as Record<string, unknown>;
  const toolCallId = stringValue(payload.toolCallId);
  if (!toolCallId) return;

  const toolName = stringValue(payload.toolName) ?? "unknown";
  const metadata = runtime.registry.get(toolName)?.metadata;
  const startedAt = event.timestamp.getTime();
  const base = {
    id: toolUsageId(runtime.sessionId, toolCallId),
    sessionID: runtime.sessionId,
    turnID: event.turnId ?? traceContext.turnId,
    traceID: event.traceId ?? traceContext.traceId,
    toolCallID: toolCallId as ToolCallId,
    toolName,
    sideEffectScope: metadata?.sideEffectScope,
    readOnly: metadata?.readOnly,
    destructive: metadata?.destructive,
    startedAt,
  };

  try {
    if (event.type === SessionEventType.ToolCallScheduled) {
      await usageStore.upsertToolUsage({
        ...base,
        status: "running",
        approvalStatus: "none",
      });
      return;
    }
    if (event.type === SessionEventType.PermissionRequested) {
      await usageStore.upsertToolUsage({
        ...base,
        status: "running",
        approvalStatus: "requested",
      });
      return;
    }
    if (event.type === SessionEventType.PermissionResolved) {
      const decision = stringValue(payload.decision);
      await usageStore.upsertToolUsage({
        ...base,
        status: "running",
        approvalStatus: decision === "deny" ? "denied" : "allowed",
      });
      return;
    }
    if (event.type === SessionEventType.PermissionDenied) {
      await usageStore.upsertToolUsage({
        ...base,
        status: "error",
        approvalStatus: "denied",
      });
      return;
    }
    if (event.type === SessionEventType.ToolCallStarted) {
      const payloadStartedAt =
        payload.startedAt instanceof Date ? payload.startedAt.getTime() : startedAt;
      await usageStore.upsertToolUsage({
        ...base,
        startedAt: payloadStartedAt,
        status: "running",
      });
      return;
    }
    if (event.type === SessionEventType.ToolCallProgress) {
      const outputBytes = numberValue(payload.outputBytes);
      const stdoutBytes = numberValue(payload.stdoutBytes);
      const stderrBytes = numberValue(payload.stderrBytes);
      await usageStore.upsertToolUsage({
        ...base,
        status: "running",
        firstOutputAt:
          outputBytes > 0 || stdoutBytes > 0 || stderrBytes > 0
            ? event.timestamp.getTime()
            : undefined,
        outputBytes,
        stdoutBytes,
        stderrBytes,
      });
      return;
    }
    if (event.type === SessionEventType.ToolCallResult) {
      const result = payload.result as Record<string, unknown> | undefined;
      const performance = result?.perf as Record<string, unknown> | undefined;
      const detail = performance?.detail as Record<string, unknown> | undefined;
      const command =
        detail?.kind === "command"
          ? (detail.command as Record<string, unknown> | undefined)
          : undefined;
      await usageStore.upsertToolUsage({
        ...base,
        status: "completed",
        completedAt: event.timestamp.getTime(),
        durationMs: numberValue(payload.duration),
        exitCode: numberValue(command?.exitCode),
        outputBytes: numberValue(result?.returnedBytes ?? result?.originalBytes),
        truncated: result?.truncated === true,
      });
      return;
    }
    if (event.type === SessionEventType.ToolCallError) {
      const error = payload.error as Record<string, unknown> | undefined;
      const errorType = stringValue(error?.type) ?? CoreErrorType.ToolExecutionFailed;
      await usageStore.upsertToolUsage({
        ...base,
        status: errorType.includes("cancel") ? "cancelled" : "error",
        completedAt: event.timestamp.getTime(),
        cancelledByUser: errorType.includes("cancel"),
        errorType,
        errorCode: stringValue(error?.code),
        errorMessage: stringValue(error?.message),
      });
    }
  } catch {
    runtime.logger?.warn("Usage tool fact write failed", {
      ...traceContextToLogContext(traceContext),
      event: "usage.tool.write.failed",
      module: "core.runtime",
      status: "failed",
      toolCallId,
    });
  }
}

function toolUsageId(sessionId: string, toolCallId: string): string {
  return `usage_tool_${sessionId}_${toolCallId}`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}
