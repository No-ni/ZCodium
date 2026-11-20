import type { Locale } from "@zcode/shared";
/** 本仓文案覆盖只参与确定性的目录合成，不持有语言设置状态。 */
export type ForkLocaleMessages = Readonly<Record<Locale, Readonly<Record<string, string>>>>;
