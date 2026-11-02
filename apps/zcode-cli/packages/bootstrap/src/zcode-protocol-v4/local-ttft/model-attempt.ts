import type { ModelNetworkStatusPayload } from "@zcode/contracts";
import { LOCAL_TTFT_MAX_DETAILS, type LocalTtftFacts } from "@zcode/shared/zcode-protocol-v4";

/**
 * 主响应/压缩请求的 attempt 与 retry_wait 事实更新：只按 ModelNetworkStatusPayload 改写本条 facts，
 * 复用调用方持有的同一份 requestState 与 now，不新增状态、不做 IO、不改事件或时序。
 * modelId/providerId 仍按既有隐私边界截断到 128 字符。
 * 返回 false 表示命中 querySource 守卫，调用方须原样 early return——包括跳过随后的 checkpoint、
 * ToolCallScheduled 输出与 terminal 收口，行为与提取前完全一致。
 */
export function applyModelNetworkAttempt(
  record: LocalTtftFacts,
  payload: ModelNetworkStatusPayload,
  requestState: Map<string, "response" | "preparation" | "failed">,
  now: () => number,
): boolean {
  if (payload.querySource !== "main_turn" && payload.querySource !== "compact") return false;
  const role = payload.querySource === "main_turn" ? "response" : "preparation";
  const details = (record.details ??= []);
  const id = `attempt:${payload.requestId}`;
  let attempt = details.find((detail) => detail.id === id);
  if (payload.type === "model_request_started" && !attempt) {
    requestState.set(record.commandId, role);
    if (details.length < LOCAL_TTFT_MAX_DETAILS) {
      attempt = {
        id,
        stage: "attempt",
        start: now(),
        requestId: payload.requestId,
        role,
        source: "cli",
      };
      details.push(attempt);
    } else record.truncated = true;
    for (const wait of details)
      if (wait.stage === "retry_wait" && wait.end === undefined && wait.role === role) {
        wait.end = now();
        wait.outcome = "completed";
      }
    if (role === "response") {
      record.requestAt ??= now();
      record.queryId ??= payload.queryId;
      record.requestId = payload.requestId;
      record.model = payload.modelId.slice(0, 128);
      record.provider = payload.providerId.slice(0, 128);
    }
  }
  if (
    (payload.type === "model_request_failed" || payload.type === "model_request_completed") &&
    attempt &&
    attempt.end === undefined
  ) {
    attempt.end = now();
    attempt.outcome = payload.type === "model_request_failed" ? "failed" : "completed";
    if (
      role === "response" &&
      payload.type === "model_request_failed" &&
      record.requestId === payload.requestId
    )
      requestState.set(record.commandId, "failed");
  }
  if (
    payload.type === "model_retry_scheduled" &&
    !details.some((detail) => detail.id === `retry:${payload.requestId}`)
  ) {
    if (details.length < LOCAL_TTFT_MAX_DETAILS)
      details.push({
        id: `retry:${payload.requestId}`,
        stage: "retry_wait",
        start: now(),
        requestId: payload.requestId,
        role,
        source: "cli",
      });
    else record.truncated = true;
  }
  return true;
}
