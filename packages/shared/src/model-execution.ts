import { z } from "zod";
import { modelSelectionSchema } from "./model-selection.js";

/**
 * 执行 Selection 退回 Session Selection 的原因。由发起方在 selectionFallback 规则里声明，
 * CLI 只透传命中规则的原因，不自行解释 provider 错误码。
 */
export const modelExecutionSelectionFallbackReasonSchema = z.enum([
  "highspeed_card_expired",
  "highspeed_request_failed",
  "highspeed_selection_unavailable",
]);

/** 历史结果仍使用严格退回结构；新输入 schema 不接入此材料。 */
const modelExecutionSelectionFallbackSchema = z
  .object({
    providerId: z.string().min(1),
    rules: z
      .array(
        z
          .object({
            reason: modelExecutionSelectionFallbackReasonSchema,
            providerErrorCode: z.string().min(1).optional(),
          })
          .strict(),
      )
      .min(1),
    target: modelSelectionSchema.optional(),
  })
  .strict()
  .optional();

/** 合并误接回了官方票据材料；输入只接受普通单轮约束，Key 由 Provider owner 提供。 */
export const modelExecutionSchema = z
  .object({
    memoryExtraction: z.literal("skip").optional(),
    selectionScope: z.literal("execution"),
    subagents: z
      .object({
        foregroundModel: z.literal("submission"),
        background: z.enum(["deny", "allow"]),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ModelExecution = z.infer<typeof modelExecutionSchema>;
export type ModelExecutionSelectionFallback = NonNullable<
  z.infer<typeof modelExecutionSelectionFallbackSchema>
>;
export type ModelExecutionSelectionFallbackRule = ModelExecutionSelectionFallback["rules"][number];
export type ModelExecutionSelectionFallbackReason = z.infer<
  typeof modelExecutionSelectionFallbackReasonSchema
>;
