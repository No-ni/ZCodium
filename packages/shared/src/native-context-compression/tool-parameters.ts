import { z } from "zod";
import { booleanField, numberField, strategyFields, toolListField } from "./field-descriptors.js";

export const nativeContextToolParametersSchema = z
  .object({
    reference: z
      .object({
        enabled: booleanField(
          "tools",
          ["大输出改为原文引用", "Replace large outputs with source references"],
          true,
        ),
        minTokens: numberField(
          "tools",
          ["引用门槛（token）", "Reference threshold (tokens)"],
          4000,
          { min: 0 },
        ),
        headChars: numberField(
          "tools",
          ["引用预览（字符）", "Reference preview (characters)"],
          96,
          { min: 0, max: 4000 },
        ),
        excludeTools: toolListField(["不引用的工具", "Tools excluded from references"]),
        inlineReadTokens: numberField(
          "tools",
          ["回取内联上限（token）", "Inline retrieval limit (tokens)"],
          4000,
          { min: 128, max: 25000, advanced: true },
        ),
      })
      .strict(),
    distill: z
      .object({
        enabled: booleanField("tools", ["即时模型摘要", "Immediate model summaries"], false),
        minTokens: numberField(
          "tools",
          ["即时摘要门槛（token）", "Immediate summary threshold (tokens)"],
          4000,
          { min: 0, advanced: true },
        ),
        minContextPercent: numberField(
          "tools",
          ["即时摘要最低占用（%）", "Minimum context usage for immediate summaries (%)"],
          0,
          { min: 0, max: 100, advanced: true },
        ),
        mediaOnly: booleanField(
          "tools",
          ["即时摘要仅处理携图结果", "Summarize only results containing images"],
          true,
          { advanced: true },
        ),
        excludeTools: toolListField([
          "不即时摘要的工具",
          "Tools excluded from immediate summaries",
        ]),
      })
      .strict(),
    simplify: z
      .object({
        enabled: booleanField(
          "tools",
          ["确定性工具简化", "Deterministic tool simplification"],
          false,
          {
            advanced: true,
            help: ["需先启用即时模型摘要。", "Immediate model summaries must also be enabled."],
          },
        ),
        minReductionPercent: numberField(
          "tools",
          ["简化最低收益（%）", "Minimum simplification reduction (%)"],
          10,
          { min: 1, max: 100, advanced: true },
        ),
        strategies: z
          .object({
            "json-fold": strategyFields("json-fold"),
            "code-trim": strategyFields("code-trim"),
            "log-select": strategyFields("log-select"),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
export const nativeContextRetrievalParametersSchema = z
  .object({
    planAware: booleanField(
      "tools",
      ["按当前计划重排检索", "Rank retrieval using the current plan"],
      false,
      { advanced: true },
    ),
    maxHits: numberField("tools", ["检索结果上限（条）", "Maximum retrieval results"], 20, {
      min: 1,
      max: 1000,
      advanced: true,
    }),
    textPageTokens: numberField(
      "tools",
      ["原文分页上限（token）", "Source page limit (tokens)"],
      4000,
      { min: 128, max: 25000, advanced: true },
    ),
  })
  .strict();
