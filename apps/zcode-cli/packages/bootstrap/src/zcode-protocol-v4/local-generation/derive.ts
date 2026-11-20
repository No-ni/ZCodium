import {
  SessionEventType,
  type SessionEvent,
  type ModelNetworkStatusPayload,
  type ModelStreamingPayload,
} from "@zcode/contracts";
import { localGenerationFactSchema, type LocalGenerationFact } from "@zcode/shared/extension-host";
import { streamingParentToolCallId } from "../local-ttft-events.js";

export function deriveLocalGenerationFact(
  instanceId: string,
  sessionId: string,
  event: SessionEvent,
): LocalGenerationFact | null {
  const base = {
    version: 1,
    instanceId,
    sessionId,
    eventId: String(event.id),
    occurredAt: event.timestamp.getTime(),
  };
  let candidate: unknown;
  if (event.type === SessionEventType.ModelStreaming) {
    const payload = event.payload as ModelStreamingPayload;
    // Bug 根因：流事件可能包含工具 JSON 或父工具输出；只对白名单正文/思考求长度，绝不透传 payload。
    if (
      !(["text_delta", "reasoning_delta"] as readonly (string | undefined)[]).includes(
        payload.kind,
      ) ||
      typeof payload.delta !== "string" ||
      !payload.delta ||
      streamingParentToolCallId(event.payload as Record<string, unknown>)
    )
      return null;
    candidate = { ...base, kind: "chunk", chars: payload.delta.length };
  } else if (event.type === SessionEventType.ModelNetworkStatus) {
    const payload = event.payload as ModelNetworkStatusPayload;
    if (payload.querySource !== "main_turn" || payload.toolCallId || payload.parentSessionId)
      return null;
    const request = {
      requestId: payload.requestId,
      providerId: payload.providerId,
      modelId: payload.modelId,
    };
    if (payload.type === "model_request_completed") {
      candidate = {
        ...base,
        ...request,
        kind: "completed",
        durationMs: payload.durationMs,
        ...(payload.timeToFirstContentMs !== undefined
          ? { timeToFirstContentMs: payload.timeToFirstContentMs }
          : {}),
        ...(payload.usage?.outputTokens !== undefined
          ? { outputTokens: payload.usage.outputTokens }
          : {}),
      };
    } else {
      const kind =
        payload.type === "model_request_started"
          ? "started"
          : payload.type === "model_retry_scheduled"
            ? "retry"
            : payload.type === "model_request_failed"
              ? "failed"
              : null;
      if (!kind) return null;
      candidate = { ...base, ...request, kind };
    }
  } else return null;
  const parsed = localGenerationFactSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
