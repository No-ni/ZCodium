import { SessionEventType, traceContextToLogContext } from "../deps.js";
import type { ModelNetworkStatusEvent, ModelUsageRecord } from "@zcode/contracts";
import type { ProviderModelUsageIdentity, RecordModelUsageInput } from "./contract.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { isModelContextExceededError } from "../helpers/index.js";
import {
  errorInfoFor,
  firstModelTokenAt,
  modelNetworkEvents,
  usageStoreFor,
  type UsageNetworkEvent,
} from "./helpers.js";

interface ProviderUsageScope {
  identity: { id: string; logicalRequestId: string; attemptIndex?: number };
  started?: UsageNetworkEvent;
  terminal?: UsageNetworkEvent;
  startIndex: number;
  endIndex: number;
  startedAt: number;
  completedAt?: number;
  retryCount: number;
}

export async function recordModelUsageFact(
  runtime: AgentRuntimeInternal,
  input: RecordModelUsageInput,
): Promise<void> {
  const usageStore = usageStoreFor(runtime);
  if (!usageStore && !input.onModelUsage) return;
  const completedAt = Date.now();
  const scopes = providerUsageScopes(input, completedAt);
  const physical = scopes.length > 0;
  if (!physical) scopes.push(legacyUsageScope(input, completedAt));

  for (let index = 0; index < scopes.length; index++) {
    const scope = scopes[index]!;
    const final = index === scopes.length - 1;
    const terminal = scope.terminal;
    const status = !physical
      ? input.status
      : terminal?.type === "model_request_failed"
        ? terminal.reason === "cancelled"
          ? "cancelled"
          : "error"
        : terminal?.type === "model_request_completed"
          ? "completed"
          : final
            ? input.status
            : "running";
    const finalSuccess = final && status === "completed";
    // 失败成本只能取同次终态；成功 result 仅补最后对应的尝试，不另写 aggregate。
    const usage = physical
      ? (terminal?.usage ?? (finalSuccess ? input.result?.usage : undefined))
      : (input.result?.usage ?? terminal?.usage);
    const firstTokenAt =
      physical && terminal?.timeToFirstContentMs !== undefined
        ? scope.startedAt + terminal.timeToFirstContentMs
        : firstModelTokenAt(input.events.slice(scope.startIndex, scope.endIndex + 1), 0);
    const durationMs =
      terminal?.durationMs ??
      (scope.completedAt !== undefined && (!physical || scope.started)
        ? scope.completedAt - scope.startedAt
        : undefined);
    const error = !physical || (final && !terminal) ? input.error : undefined;
    const errorInfo = errorInfoFor(error, terminal);
    const contextExceeded =
      terminal?.reason === "context_exceeded" || isModelContextExceededError(error);
    const record: ModelUsageRecord = {
      id: scope.identity.id,
      logicalRequestId: scope.identity.logicalRequestId,
      attemptIndex: scope.identity.attemptIndex,
      sessionID: runtime.sessionId,
      turnID: input.traceContext.turnId,
      traceID: input.traceContext.traceId,
      spanID: input.traceContext.spanId,
      assistantMessageID: input.assistantMessageId,
      parentUserMessageID: input.parentUserMessageId,
      querySource: input.querySource,
      providerId: terminal?.providerId ?? scope.started?.providerId ?? input.model.providerId,
      modelId: terminal?.modelId ?? scope.started?.modelId ?? input.model.modelId,
      reasoningLevel: input.model.options.reasoningLevel,
      agent: runtime.config.agentName ?? "zcode-agent",
      mode: runtime.config.mode ?? "build",
      taskType: runtime.config.taskType ?? "interactive",
      status,
      startedAt: scope.startedAt,
      firstTokenAt,
      completedAt: scope.completedAt,
      durationMs,
      timeToFirstTokenMs: firstTokenAt === undefined ? undefined : firstTokenAt - scope.startedAt,
      finishReason:
        terminal?.finishReason ?? (finalSuccess ? input.result?.finishReason : undefined),
      toolCallCount: finalSuccess ? (input.toolCallCount ?? 0) : undefined,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      reasoningTokens: usage?.reasoningTokens,
      cacheCreationInputTokens: usage?.cacheWriteTokens,
      cacheReadInputTokens: usage?.cacheReadTokens,
      providerTotalTokens: usage?.totalTokens,
      retryCount: scope.retryCount,
      retryable: errorInfo.retryable ?? scope.retryCount > 0,
      cancelledByUser: status === "cancelled",
      contextExceeded,
      errorType: errorInfo.type,
      errorCode: errorInfo.code,
      rawUsage: usage,
      providerMetadata: finalSuccess ? input.result?.providerMetadata : undefined,
    };
    try {
      await usageStore?.recordModelUsage(record);
    } catch {
      runtime.logger?.warn("Usage model fact write failed", {
        ...traceContextToLogContext(input.traceContext),
        event: "usage.model.write.failed",
        module: "core.runtime",
        status: "failed",
      });
    }
    try {
      // 通用账本写入失败仍交付同一事实，Goal 不能因此静默漏费；两个出口独立隔离。
      await input.onModelUsage?.(record);
    } catch {
      runtime.logger?.warn("Usage model callback failed", {
        ...traceContextToLogContext(input.traceContext),
        event: "usage.model.callback.failed",
        module: "core.runtime",
        status: "failed",
      });
    }
  }
}

/** Provider requestId 区分 stream/HTTP 调用；attempt 从 1 起步，账本和观察共用从 0 起步的键。 */
export function providerModelUsageIdentity(
  querySource: string,
  event: Pick<ModelNetworkStatusEvent, "requestId" | "attempt">,
): ProviderModelUsageIdentity {
  if (
    typeof event.requestId !== "string" ||
    !event.requestId ||
    !Number.isSafeInteger(event.attempt) ||
    event.attempt < 1
  ) {
    throw new TypeError("MODEL_USAGE_ATTEMPT_IDENTITY_INVALID");
  }
  const attemptIndex = event.attempt - 1;
  return {
    id: `usage_model_${querySource}_${event.requestId}_${attemptIndex}`,
    logicalRequestId: event.requestId,
    attemptIndex,
  };
}

function providerUsageScopes(
  input: RecordModelUsageInput,
  completedAt: number,
): ProviderUsageScope[] {
  const scopes = new Map<string, ProviderUsageScope>();
  for (let index = input.networkEventStartIndex; index < input.events.length; index++) {
    const event = input.events[index]!;
    if (event.type !== SessionEventType.ModelNetworkStatus) continue;
    const payload = event.payload as UsageNetworkEvent | null;
    if (
      !payload ||
      typeof payload.requestId !== "string" ||
      !payload.requestId ||
      !Number.isSafeInteger(payload.attempt) ||
      payload.attempt! < 1
    )
      continue;
    const identity = providerModelUsageIdentity(input.querySource, {
      requestId: payload.requestId,
      attempt: payload.attempt!,
    });
    if (
      !["model_request_started", "model_request_completed", "model_request_failed"].includes(
        payload.type,
      )
    ) {
      if (payload.type === "model_retry_scheduled" && scopes.has(identity.id)) {
        scopes.get(identity.id)!.retryCount = 1;
      }
      continue;
    }
    const timestamp = payload.timestamp ? Date.parse(payload.timestamp) : NaN;
    const at = Number.isFinite(timestamp) ? timestamp : event.timestamp.getTime();
    const scope = scopes.get(identity.id) ?? {
      identity,
      startIndex: index,
      endIndex: index,
      startedAt: input.startedAt,
      retryCount: 0,
    };
    scopes.set(identity.id, scope);
    if (payload.type === "model_request_started" && !scope.started) {
      scope.started = payload;
      scope.startedAt = at;
      scope.startIndex = index;
    } else if (payload.type !== "model_request_started" && !scope.terminal) {
      // 同尝试重复终态只结算一次，不能再次扣费或覆盖当时的真实事实。
      scope.terminal = payload;
      scope.completedAt = at;
      scope.endIndex = index;
      if (!scope.started && payload.durationMs !== undefined)
        scope.startedAt = at - payload.durationMs;
    }
  }
  const ordered = [...scopes.values()];
  for (let index = 0; index < ordered.length; index++) {
    const scope = ordered[index]!;
    if (scope.terminal) continue;
    // 调用中断后不能把 started 时间当作终态制造 0ms；保留本次实际增量窗口。
    scope.endIndex = (ordered[index + 1]?.startIndex ?? input.events.length) - 1;
    if (index === ordered.length - 1) scope.completedAt = completedAt;
  }
  return ordered;
}

function legacyUsageScope(input: RecordModelUsageInput, completedAt: number): ProviderUsageScope {
  const network = modelNetworkEvents(input.events.slice(input.networkEventStartIndex));
  const logicalRequestId =
    input.assistantMessageId ??
    input.traceContext.spanId ??
    `${input.querySource}_${input.startedAt}`;
  return {
    identity: {
      id: `usage_model_${input.querySource}_${logicalRequestId}_${input.attemptIndex ?? 0}`,
      logicalRequestId,
      attemptIndex: input.attemptIndex,
    },
    startIndex: input.networkEventStartIndex,
    endIndex: input.events.length - 1,
    startedAt: input.startedAt,
    completedAt,
    terminal: network.findLast((event) => event.type === "model_request_failed"),
    retryCount: network.filter((event) => event.type === "model_retry_scheduled").length,
  };
}
