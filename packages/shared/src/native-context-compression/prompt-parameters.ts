import { z } from "zod";
import { modelSelectionSchema } from "../model-selection.js";
import {
  autoNumberField,
  booleanField,
  customPromptOptions,
  describe,
  localize,
  selectField,
  textField,
} from "./field-descriptors.js";

export const nativeContextMaintenanceParametersSchema = z
  .object({
    model: describe(
      z.union([z.literal("follow-current"), modelSelectionSchema]),
      "prompts",
      "model",
      ["摘要模型", "Summary model"],
      "follow-current",
      {
        options: [["follow-current", "跟随当前模型"]],
        optionLabels: { "follow-current": localize(["跟随当前模型", "Follow current model"]) },
        help: [
          "仅选择当前环境已配置的模型；不新增凭据或跨 Provider 自动回退。",
          "Choose a model already configured in this environment; no extra credentials or automatic provider fallback.",
        ],
      },
    ),
    stream: selectField(
      "prompts",
      ["摘要流式请求", "Streaming summary requests"],
      [
        ["auto", "跟随模型能力", "Follow model capabilities"],
        ["always", "始终流式", "Always stream"],
      ],
      "auto",
    ),
    maxOutputTokens: autoNumberField(
      "prompts",
      ["摘要输出预算（token）", "Summary output budget (tokens)"],
      "auto",
      {
        min: 1,
        help: [
          "auto 沿用选定模型预算；显式值受模型输出与执行预算约束。",
          "Auto follows the selected model budget; explicit values must fit the model output and execution budgets.",
        ],
      },
    ),
  })
  .strict();
export const nativeContextPromptParametersSchema = z
  .object({
    pack: selectField(
      "prompts",
      ["摘要提示词包", "Summary prompt pack"],
      [
        ["default", "默认", "Default"],
        ["lean", "精简", "Lean"],
      ],
      "default",
    ),
    compressPhilosophy: textField(
      "prompts",
      ["摘要指导", "Summary guidance"],
      "",
      customPromptOptions,
    ),
    howToCompressRules: textField(
      "prompts",
      ["摘要操作规则", "Compression rules"],
      "",
      customPromptOptions,
    ),
    tier2DistillRules: textField(
      "prompts",
      ["T2 蒸馏指导", "T2 distillation guidance"],
      "",
      customPromptOptions,
    ),
    tier3CondenseRules: textField(
      "prompts",
      ["T3 浓缩指导", "T3 condensation guidance"],
      "",
      customPromptOptions,
    ),
    visibilityMarkers: booleanField(
      "prompts",
      ["模型可见的压缩说明", "Compression notes visible to the model"],
      true,
      { advanced: true },
    ),
    messageTimestamps: booleanField(
      "prompts",
      ["模型可见的首见时间", "First-seen timestamps visible to the model"],
      true,
      { advanced: true },
    ),
  })
  .strict();
