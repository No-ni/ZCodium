import { SessionEventType, isCoreError } from "@zcode/contracts";
import type { SessionEvent, ModelUsage } from "@zcode/contracts";

export function modelNetworkEvents(events: readonly SessionEvent[]) {
  return events
    .filter((event) => event.type === SessionEventType.ModelNetworkStatus)
    .map((event) => event.payload)
    .filter(
      (
        payload,
      ): payload is {
        type: string;
        reason?: string;
        retryable?: boolean;
        message?: string;
        usage?: ModelUsage;
      } => Boolean(payload && typeof payload === "object" && "type" in payload),
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
  failedNetworkEvent: { reason?: string; retryable?: boolean; message?: string } | undefined,
): { code?: string; message?: string; retryable?: boolean; type?: string } {
  if (isCoreError(error)) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      type: error.type,
    };
  }
  if (error instanceof Error) {
    return {
      message: error.message,
      retryable: failedNetworkEvent?.retryable,
      type: failedNetworkEvent?.reason ?? error.name,
    };
  }
  if (failedNetworkEvent) {
    return {
      message: failedNetworkEvent.message,
      retryable: failedNetworkEvent.retryable,
      type: failedNetworkEvent.reason,
    };
  }
  return {};
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}
