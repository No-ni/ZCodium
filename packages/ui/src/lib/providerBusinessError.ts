import { isOffPeakTicketExpiredError } from "@zcode/shared";

/** 与 core `model-errors.ts` 中 anomaly guard 文案保持一致。 */
export const SUSPICIOUS_EMPTY_MODEL_RESULT_MESSAGE =
  "Model returned no text, no tool calls, and no usage before completing the turn.";

/**
 * 历史闲时票据错误（上游 3102：票据失效或过期）。
 * 旧适配层会把该业务码包成 `off-peak-ticket-expired: <上游原文>` 落到 turn 错误里，
 * 也可能直接把 3102 作为 code 保留。闲时任务运行时已移除，这里只保留历史错误的
 * 本地化展示，避免横幅把上游原文直接怼给用户。
 */
export function resolveOffPeakTicketExpiredBusinessCode(
  code: string | undefined,
  message: string | undefined,
): "3102" | undefined {
  if (code?.trim() === "3102") {
    return "3102";
  }
  return isOffPeakTicketExpiredError(message) ? "3102" : undefined;
}

export function isSuspiciousEmptyModelResultMessage(message: string | undefined): boolean {
  if (!message) {
    return false;
  }

  return (
    message.includes(SUSPICIOUS_EMPTY_MODEL_RESULT_MESSAGE) ||
    message.includes("Model returned no text")
  );
}
