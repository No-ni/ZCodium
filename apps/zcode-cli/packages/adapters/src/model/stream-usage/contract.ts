import type { LanguageModelUsage } from "ai";

/** 一个已开始但未 finish-step 的 SDK 流；只含真实已报告的数字，不负责记账。 */
export interface PartialStreamUsageInput {
  previous?: Partial<LanguageModelUsage>;
  rawValue: unknown;
  providerKind?: string;
}
