import { z } from "zod";

export const nativeContextToolProtectionItemSchema = z
  .object({
    name: z.string().min(1).max(512),
    protected: z.boolean(),
    latest: z.boolean(),
    earlyFold: z.boolean(),
    preserveRecent: z.boolean(),
    referenceExcluded: z.boolean(),
    distillExcluded: z.boolean(),
  })
  .strict();
export type NativeContextToolProtectionItem = z.infer<typeof nativeContextToolProtectionItemSchema>;

/** 当前 registry 与已保存策略的只读匹配结果；UI 不根据草稿重新推导。 */
export const nativeContextResolvedToolProtectionSchema = z
  .object({
    items: z.array(nativeContextToolProtectionItemSchema).max(200),
    total: z.number().int().nonnegative(),
  })
  .strict()
  .refine((value) => value.total >= value.items.length, {
    path: ["total"],
    message: "Total tool count cannot be smaller than the returned items",
  });
export type NativeContextResolvedToolProtection = z.infer<
  typeof nativeContextResolvedToolProtectionSchema
>;
