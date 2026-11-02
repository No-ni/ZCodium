// 仅用于历史错误的只读本地化；不恢复官方账号、配额刷新、购买或换证操作。
export const SUSPICIOUS_EMPTY_MODEL_RESULT_MESSAGE =
  "Model returned no text, no tool calls, and no usage before completing the turn.";

import { isOffPeakTicketExpiredError, OFF_PEAK_TICKET_EXPIRED_MARKER } from "@zcode/shared";

export const PROVIDER_BUSINESS_ERROR_CODES = [
  "1006",
  "1005",
  "3006",
  "3001",
  "3007",
  "3008",
  "3009",
  "3010",
  "3002",
  "3102",
  "3106",
  "2007",
  "429",
] as const;

export type ProviderBusinessErrorCode = (typeof PROVIDER_BUSINESS_ERROR_CODES)[number];

export const PROVIDER_BUSINESS_ERROR_MESSAGE_IDS: Record<ProviderBusinessErrorCode, string> = {
  "1006": "zcode.error.providerBusiness.1006",
  "1005": "zcode.error.providerBusiness.1005",
  "3006": "zcode.error.providerBusiness.3006",
  "3002": "zcode.error.providerBusiness.3002",
  "3001": "zcode.error.providerBusiness.3001",
  "3007": "zcode.error.providerBusiness.3007",
  "3008": "zcode.error.providerBusiness.3008",
  "3009": "zcode.error.providerBusiness.3009",
  "3010": "zcode.error.providerBusiness.3010",
  "3102": "zcode.error.providerBusiness.3102",
  "3106": "zcode.error.providerBusiness.3106",
  "2007": "zcode.error.providerBusiness.2007",
  "429": "zcode.error.providerBusiness.429",
};

export function isProviderBusinessErrorCode(
  code: string | undefined,
): code is ProviderBusinessErrorCode {
  if (!code) {
    return false;
  }
  return (PROVIDER_BUSINESS_ERROR_CODES as readonly string[]).includes(code);
}

export function getProviderBusinessErrorMessageId(code: string | undefined): string | undefined {
  if (code === OFF_PEAK_TICKET_EXPIRED_MARKER) {
    return "zcode.error.offPeakTicketExpired";
  }
  if (!isProviderBusinessErrorCode(code)) {
    return undefined;
  }
  return PROVIDER_BUSINESS_ERROR_MESSAGE_IDS[code];
}

export function resolveOffPeakTicketExpiredBusinessCode(
  code: string | undefined,
  message: string | undefined,
): "3102" | "3106" | typeof OFF_PEAK_TICKET_EXPIRED_MARKER | undefined {
  const normalized = code?.trim();
  if (normalized === "3102" || normalized === "3106") {
    return normalized;
  }
  return isOffPeakTicketExpiredError(message) ? OFF_PEAK_TICKET_EXPIRED_MARKER : undefined;
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
