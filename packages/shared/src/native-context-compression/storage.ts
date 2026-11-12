import { z } from "zod";
import { nativeContextPolicySchema } from "./configuration.js";
import { nativeContextOperationSchema, nativeContextObservationSchema } from "./observation.js";

const identity = z.string().min(1).max(240);
const count = z.number().int().nonnegative();
export const nativeContextSourceSchema = z
  .object({
    rawId: identity,
    ref: identity,
    messageId: identity,
    partId: identity.nullable(),
    entryIndex: count,
    imageIndex: count.nullable(),
    kind: z.enum(["text", "tool-call", "tool-result", "image"]),
    sourceKind: z.enum(["attachment", "read", "bash", "mcp", "other"]),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    artifactUri: z.string().max(1000).nullable(),
    originalAvailable: z.boolean(),
    originalBytes: count.nullable(),
    width: count.nullable(),
    height: count.nullable(),
    firstSeenAt: count,
    tokenSnapshot: count,
  })
  .strict();
export type NativeContextSource = z.infer<typeof nativeContextSourceSchema>;

export const nativeContextImageReceiptSchema = z
  .object({
    ref: identity,
    responseMessageId: identity,
    logicalRequestId: identity,
    modelKey: identity,
    policyHash: z.string().regex(/^[a-f0-9]{64}$/),
    representationHash: z.string().regex(/^[a-f0-9]{64}$/),
    generation: count,
  })
  .strict();
export type NativeContextImageReceipt = z.infer<typeof nativeContextImageReceiptSchema>;

export const nativeContextStoredStateSchema = z
  .object({
    version: z.literal(1),
    policy: nativeContextPolicySchema,
    revision: count,
    generation: count,
    historyVersion: identity,
    compactBoundaryId: identity,
    requestSeq: count,
    // 内核状态只供 CLI 使用；UI query/snapshot 不传递此对象或来源内容。
    kernel: z.record(z.string(), z.unknown()),
    sources: z.array(nativeContextSourceSchema).max(1000000),
    imageReceipts: z.array(nativeContextImageReceiptSchema).max(1000000),
    lastCheckedHistoryVersion: identity.nullable(),
    lastMaintenanceTokens: count,
    roundsSinceMaintenance: count,
    estimateHoldRounds: count,
  })
  .strict();
export type NativeContextStoredState = z.infer<typeof nativeContextStoredStateSchema>;

export const nativeContextCommitSchema = z
  .object({
    expectedRevision: count.nullable(),
    expectedGeneration: count,
    state: nativeContextStoredStateSchema,
    // 内部事务还承担 rewind 的完整 membership 重建；RPC/query 的页上限独立保留。
    operations: z.array(nativeContextOperationSchema).optional(),
    observations: z.array(nativeContextObservationSchema).optional(),
  })
  .strict();
export type NativeContextCommit = z.infer<typeof nativeContextCommitSchema>;

export const nativeContextForkBundleSchema = z
  .object({
    state: nativeContextStoredStateSchema,
    operations: z.array(nativeContextOperationSchema),
    observations: z.array(nativeContextObservationSchema),
  })
  .strict();
export type NativeContextForkBundle = z.infer<typeof nativeContextForkBundleSchema>;
