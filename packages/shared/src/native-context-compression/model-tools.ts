import { z } from "zod";
const ref = z.string().min(1).max(240);
export const nativeContextCompressToolSchema = z
  .object({
    ranges: z
      .array(
        z.object({ startRef: ref, endRef: ref, summary: z.string().min(1).max(40_000) }).strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();
export const nativeContextSearchToolSchema = z
  .object({
    query: z.string().min(1).max(2000),
    maxHits: z.number().int().min(1).max(100).optional(),
  })
  .strict();
export const nativeContextReadToolSchema = z
  .object({
    ref,
    offset: z.number().int().nonnegative().optional(),
    limitTokens: z.number().int().min(1).max(25_000).optional(),
  })
  .strict();
export const nativeContextReadImageToolSchema = z.object({ ref }).strict();
export const nativeContextCompressToolJsonSchema = z.toJSONSchema(nativeContextCompressToolSchema);
export const nativeContextSearchToolJsonSchema = z.toJSONSchema(nativeContextSearchToolSchema);
export const nativeContextReadToolJsonSchema = z.toJSONSchema(nativeContextReadToolSchema);
export const nativeContextReadImageToolJsonSchema = z.toJSONSchema(
  nativeContextReadImageToolSchema,
);
