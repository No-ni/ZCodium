import { SessionEventType, isCoreError } from "../deps.js";
import type { ModelUsage, SessionEvent, UsageStorePort } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";

export interface UsageNetworkEvent {
  type: string;
  requestId?: string;
  attempt?: number;
  timestamp?: string;
  providerId?: string;
  modelId?: string;
  reason?: string;
  retryable?: boolean;
  errorCode?: string;
  usage?: ModelUsage;
  durationMs?: number;
  finishReason?: string;
  timeToFirstContentMs?: number;
}

export function usageStoreFor(runtime: AgentRuntimeInternal): UsageStorePort | undefined {
  const candidate = runtime.sessionStore as Partial<UsageStorePort> | undefined;
  return candidate?.recordModelUsage &&
    candidate.upsertTurnUsage &&
    candidate.upsertToolUsage &&
    candidate.pruneUsage
    ? (candidate as UsageStorePort)
    : undefined;
}

export function modelNetworkEvents(events: readonly SessionEvent[]): UsageNetworkEvent[] {
  return events
    .filter((event) => event.type === SessionEventType.ModelNetworkStatus)
    .map((event) => event.payload)
    .filter((payload): payload is UsageNetworkEvent =>
      Boolean(payload && typeof payload === "object" && "type" in payload),
    );
}

export function firstModelTokenAt(
  events: readonly SessionEvent[],
  startIndex: number,
): number | undefined {
  for (const event of events.slice(startIndex)) {
    if (event.type !== SessionEventType.ModelStreaming) continue;
    const payload = event.payload as { delta?: string; kind?: string };
    if (
      (payload.kind === "text_delta" || payload.kind === "reasoning_delta") &&
      payload.delta &&
      payload.delta.length > 0
    ) {
      return event.timestamp.getTime();
    }
  }
  return undefined;
}

export function errorInfoFor(
  error: unknown,
  failedNetworkEvent: UsageNetworkEvent | undefined,
): { code?: string; retryable?: boolean; type?: string } {
  if (isCoreError(error)) {
    return { code: error.code, retryable: error.retryable, type: error.type };
  }
  if (error instanceof Error) {
    return {
      retryable: failedNetworkEvent?.retryable,
      type: failedNetworkEvent?.reason ?? error.name,
    };
  }
  return failedNetworkEvent
    ? {
        code: failedNetworkEvent.errorCode,
        retryable: failedNetworkEvent.retryable,
        type: failedNetworkEvent.reason,
      }
    : {};
}
