import { z } from "zod";
import { nativeContextPolicySchema } from "./configuration.js";
import { nativeContextResolvedToolProtectionSchema } from "./tool-protection.js";

const count = z.number().int().nonnegative().nullable();
const identity = z.string().min(1).max(240);
export const nativeContextModelSchema = z
  .object({ providerId: identity, modelId: identity })
  .strict();
export const nativeContextImageMeasurementSchema = z
  .object({
    sourceCount: z.number().int().nonnegative(),
    sourceCoverage: z.number().int().nonnegative(),
    sentCount: z.number().int().nonnegative(),
    omittedCount: z.number().int().nonnegative(),
    foldedCount: z.number().int().nonnegative(),
    resizedCount: z.number().int().nonnegative(),
    restoredCount: z.number().int().nonnegative(),
    beforeBytes: count,
    afterBytes: count,
  })
  .strict();
export type NativeContextImageMeasurement = z.infer<typeof nativeContextImageMeasurementSchema>;

export const nativeContextObservationSchema = z
  .object({
    id: identity,
    logicalRequestId: identity,
    usageRecordRef: identity,
    anchorMessageId: identity.nullable().optional(),
    attemptIndex: z.number().int().nonnegative(),
    requestSeq: z.number().int().nonnegative(),
    purpose: z.enum(["main", "maintenance", "decision"]),
    status: z.enum(["prepared", "completed", "error", "cancelled", "obsolete"]),
    generation: z.number().int().nonnegative(),
    historyVersion: identity,
    policyVersion: z.number().int().nonnegative(),
    segmentId: identity,
    estimatorVersion: z.literal("native-context-v1"),
    measurementScope: z.enum(["complete", "text-only", "unknown"]),
    model: nativeContextModelSchema,
    inputBudget: count,
    contextWindow: count,
    startTokens: count,
    targetTokens: count,
    beforeEstimate: count,
    afterEstimate: count,
    textBeforeEstimate: count,
    textAfterEstimate: count,
    actualInputTokens: count,
    outputTokens: count,
    cacheReadTokens: count,
    cacheCreateTokens: count,
    visionTokens: count,
    images: nativeContextImageMeasurementSchema,
    operationIds: z.array(identity).max(100),
    origin: z.enum(["own", "inherited"]),
    createdAt: z.number().int().nonnegative(),
    completedAt: count,
  })
  .strict();
export type NativeContextObservation = z.infer<typeof nativeContextObservationSchema>;

export const nativeContextRecordSourceSchema = z
  .object({
    ref: identity,
    messageId: identity,
    partId: identity.nullable(),
    imageIndex: count,
    kind: z.enum(["text", "tool-result", "image"]),
    originalAvailable: z.boolean(),
  })
  .strict();
export type NativeContextRecordSource = z.infer<typeof nativeContextRecordSourceSchema>;

export const nativeContextOperationSchema = z
  .object({
    operationId: identity,
    commandId: identity.nullable(),
    anchorRequestSeq: z.number().int().nonnegative().nullable().optional(),
    anchorMessageId: identity.nullable().optional(),
    kind: z.enum([
      "summary",
      "reference",
      "image",
      "restore-image",
      "decision",
      "compact-boundary",
    ]),
    trigger: z.enum(["automatic", "manual", "model", "capacity"]),
    status: z.enum([
      "preparing",
      "running",
      "completed",
      "error",
      "cancelled",
      "obsolete",
      "no-benefit",
    ]),
    generation: z.number().int().nonnegative(),
    policyVersion: z.number().int().nonnegative(),
    historyVersion: identity,
    segmentId: identity,
    createdAt: z.number().int().nonnegative(),
    completedAt: count,
    elapsedMs: count,
    beforeEstimate: count,
    afterEstimate: count,
    model: nativeContextModelSchema.nullable(),
    observationIds: z.array(identity).max(100),
    blockIds: z.array(identity).max(1000),
    sources: z.array(nativeContextRecordSourceSchema).max(100000),
    summary: z.string().max(1000000),
    reason: z
      .enum([
        "none",
        "no-range",
        "no-benefit",
        "cancelled",
        "policy-changed",
        "history-changed",
        "invalid-summary",
        "model-error",
        "storage-error",
        "capacity",
        "unsupported",
      ])
      .nullable(),
    origin: z.enum(["own", "inherited"]),
  })
  .strict();
export type NativeContextOperation = z.infer<typeof nativeContextOperationSchema>;
export const nativeContextOperationSummarySchema = nativeContextOperationSchema.omit({
  sources: true,
  summary: true,
});
export type NativeContextOperationSummary = z.infer<typeof nativeContextOperationSummarySchema>;

/** 记录保留请求时的世代；view* 描述当前只读页，避免 fork 把祖先事实改写。 */
export const nativeContextOperationDetailSchema = nativeContextOperationSchema
  .extend({
    sources: z.array(nativeContextRecordSourceSchema).max(100),
    summary: z.string().max(40000),
    sourceTotal: z.number().int().nonnegative(),
    nextSourceCursor: count,
    summaryOffset: z.number().int().nonnegative(),
    nextSummaryOffset: count,
    summaryTotalChars: z.number().int().nonnegative(),
    revision: z.number().int().nonnegative(),
    viewGeneration: z.number().int().nonnegative(),
    viewHistoryVersion: identity,
  })
  .strict();
export type NativeContextOperationDetail = z.infer<typeof nativeContextOperationDetailSchema>;
export const nativeContextRecordRequestSchema = z
  .object({
    sessionId: identity,
    operationId: identity,
    sourceCursor: z.number().int().nonnegative().optional(),
    sourceLimit: z.number().int().min(1).max(100).optional(),
    summaryOffset: z.number().int().nonnegative().optional(),
    summaryLimitChars: z.number().int().min(1).max(40000).optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .strict();
export type NativeContextRecordRequest = z.infer<typeof nativeContextRecordRequestSchema>;

export const nativeContextStatusSchema = z
  .object({
    policy: nativeContextPolicySchema,
    revision: z.number().int().nonnegative(),
    generation: z.number().int().nonnegative(),
    historyVersion: identity,
    currentSegmentId: identity,
    phase: z.enum(["idle", "compressing"]),
    /** 仅本次在途维护的 Runtime execution；排队、终态与持久化冷记录不包含它。 */
    activeMaintenance: z
      .object({
        foregroundExecutionId: identity,
        startedAt: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    inputBudget: count,
    effectiveBlocks: z.number().int().nonnegative(),
    referencedOutputs: z.number().int().nonnegative(),
    resolvedToolProtection: nativeContextResolvedToolProtectionSchema.optional(),
    unavailableReason: z
      .enum([
        "offline",
        "recovering",
        "no-model",
        "no-range",
        "busy",
        "paused",
        "budget",
        "unsupported-store",
        "unsupported-model",
      ])
      .nullable(),
    lastObservation: nativeContextObservationSchema.nullable(),
    lastOperation: nativeContextOperationSummarySchema.nullable(),
  })
  .strict()
  .refine((status) => status.phase === "compressing" || !status.activeMaintenance, {
    message: "Idle native context cannot expose an active maintenance execution",
    path: ["activeMaintenance"],
  });
export type NativeContextStatus = z.infer<typeof nativeContextStatusSchema>;

export const nativeContextPageRequestSchema = z
  .object({
    sessionId: identity,
    cursor: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(200).optional(),
    segmentId: identity.optional(),
    purpose: z.enum(["main", "maintenance", "decision"]).optional(),
    operationId: identity.optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .strict();
export type NativeContextPageRequest = z.infer<typeof nativeContextPageRequestSchema>;
export interface NativeContextPage<T> {
  items: T[];
  nextCursor: number | null;
  revision: number;
  generation: number;
  historyVersion: string;
}
const pageVersionShape = {
  nextCursor: count,
  revision: z.number().int().nonnegative(),
  generation: z.number().int().nonnegative(),
  historyVersion: identity,
};
export const nativeContextObservationsPageSchema = z
  .object({
    items: z.array(nativeContextObservationSchema).max(200),
    ...pageVersionShape,
  })
  .strict();
export const nativeContextRecordsPageSchema = z
  .object({
    items: z.array(nativeContextOperationSummarySchema).max(200),
    ...pageVersionShape,
  })
  .strict();

export const nativeContextSourcePageSchema = z
  .object({
    ref: identity,
    text: z.string().max(100000),
    offset: z.number().int().nonnegative(),
    nextOffset: count,
    originalAvailable: z.boolean(),
    revision: z.number().int().nonnegative(),
    generation: z.number().int().nonnegative(),
    historyVersion: identity,
  })
  .strict();
export type NativeContextSourcePage = z.infer<typeof nativeContextSourcePageSchema>;

export const nativeContextImageSchema = z
  .object({
    ref: identity,
    dataUrl: z.string().max(700000).nullable(),
    // 原图通过至多 512KiB 的 decoded 字节块读取；完整 dataUrl 只在 UI 本地组合。
    dataBase64: z.string().max(700000).nullable(),
    mediaType: z.string().max(100).nullable(),
    offset: z.number().int().nonnegative(),
    nextOffset: count,
    originalAvailable: z.boolean(),
    originalBytes: count,
    width: count,
    height: count,
    reason: z.enum(["unavailable", "capacity"]).nullable(),
    revision: z.number().int().nonnegative(),
    generation: z.number().int().nonnegative(),
    historyVersion: identity,
  })
  .strict();
export type NativeContextImage = z.infer<typeof nativeContextImageSchema>;

export const nativeContextSourceRequestSchema = z
  .object({
    sessionId: identity,
    ref: identity,
    offset: z.number().int().nonnegative().optional(),
    limitTokens: z.number().int().min(1).max(25000).optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .strict();
export type NativeContextSourceRequest = z.infer<typeof nativeContextSourceRequestSchema>;
export const nativeContextImageRequestSchema = z
  .object({
    sessionId: identity,
    ref: identity,
    offset: z.number().int().nonnegative().optional(),
    maxBytes: z
      .number()
      .int()
      .min(1)
      .max(512 * 1024)
      .optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .strict();
export type NativeContextImageRequest = z.infer<typeof nativeContextImageRequestSchema>;

export function emptyNativeContextImageMeasurement(): NativeContextImageMeasurement {
  return {
    sourceCount: 0,
    sourceCoverage: 0,
    sentCount: 0,
    omittedCount: 0,
    foldedCount: 0,
    resizedCount: 0,
    restoredCount: 0,
    beforeBytes: 0,
    afterBytes: 0,
  };
}

export function nativeContextCacheHitPercent(observation: NativeContextObservation): number | null {
  const total = observation.actualInputTokens;
  const read = observation.cacheReadTokens;
  return total !== null && total > 0 && read !== null && read <= total
    ? (read / total) * 100
    : null;
}
