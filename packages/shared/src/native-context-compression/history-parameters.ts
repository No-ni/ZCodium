import { z } from "zod";
import { booleanField, numberField, selectField, toolListField } from "./field-descriptors.js";

export const nativeContextHistoryParametersSchema = z
  .object({
    preserveTurns: numberField(
      "history",
      ["保留完整交互轮", "Preserve complete interaction rounds"],
      4,
      { min: 0, max: 100 },
    ),
    preserveMessages: numberField("history", ["保留原始消息数", "Preserve canonical messages"], 3, {
      min: 0,
      max: 1000,
    }),
    preserveTokens: numberField("history", ["保留近期 token", "Preserve recent tokens"], 5000, {
      min: 0,
    }),
    protectedTools: toolListField(
      ["全历史保护的工具", "Tools protected throughout history"],
      "history",
    ),
    protectedLatestTools: toolListField(
      ["保护最新结果的工具", "Tools with their latest result protected"],
      "history",
    ),
    earlyFoldTools: toolListField(
      ["允许提前整理的已完成工具", "Completed tools eligible for early compression"],
      "history",
    ),
    preserveRecentTools: toolListField(
      ["仍保留近期结果的工具", "Tools with recent results preserved"],
      "history",
    ),
  })
  .strict();
export const nativeContextSummaryParametersSchema = z
  .object({
    minChars: numberField(
      "history",
      ["摘要最短（字符）", "Minimum summary length (characters)"],
      50,
      { min: 0 },
    ),
    maxChars: numberField(
      "history",
      ["摘要最长（字符）", "Maximum summary length (characters)"],
      20000,
      {
        min: 0,
        help: [
          "0 不限制字符数；模型输出预算仍有效。",
          "Zero removes the character limit; the model output budget still applies.",
        ],
      },
    ),
    minRangeChars: numberField(
      "history",
      ["最小原文范围（字符）", "Minimum source range (characters)"],
      5000,
      { min: 0, advanced: true },
    ),
    minReductionPercent: numberField(
      "history",
      ["摘要最低净收益（%）", "Minimum net summary reduction (%)"],
      10,
      { min: 0, max: 99, advanced: true },
    ),
    tiersEnabled: booleanField("history", ["启用多层摘要", "Enable tiered summaries"], true, {
      advanced: true,
    }),
    tier2BlockCount: numberField(
      "history",
      ["T2 触发（生效 T1 块）", "T2 trigger (active T1 blocks)"],
      1000,
      { min: 1, advanced: true },
    ),
    tier3BlockCount: numberField(
      "history",
      ["T3 触发（生效 T2 块）", "T3 trigger (active T2 blocks)"],
      2000,
      { min: 1, advanced: true },
    ),
    promotionSurvivals: numberField(
      "history",
      ["合并资格存活次数", "Survivals required for promotion"],
      5,
      { min: 1, advanced: true },
    ),
  })
  .strict();
export const nativeContextReasoningParametersSchema = z
  .object({
    completedMode: selectField(
      "history",
      ["已结束推理块", "Completed reasoning blocks"],
      [
        ["retain", "保留", "Retain"],
        ["provider-safe-omit", "模型允许时省略", "Omit when the provider permits"],
      ],
      "retain",
      { advanced: true },
    ),
    thresholdChars: numberField(
      "history",
      ["推理省略门槛（字符）", "Reasoning omission threshold (characters)"],
      2048,
      { min: 0, advanced: true },
    ),
  })
  .strict();
