import { z } from "zod";
import {
  nativeContextModelSchema,
  nativeContextObservationSchema,
  nativeContextOperationSummarySchema,
} from "@zcode/shared/native-context-compression";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const nativeContextLedgerHostPreferencesSchema = z
  .object({
    memoryEnabled: z.literal(false),
    integratedTerminalShell: z
      .object({ mode: z.literal("auto") })
      .strict()
      .optional(),
    dynamicWorkflowMode: z.enum(["disabled", "onDemand", "alwaysOn"]).optional(),
  })
  .strict();
export const nativeContextLedgerSeedFactsSchema = z
  .object({
    canonicalSha256: sha256,
    sourcesSha256: sha256,
    kernelSha256: sha256,
    imageReceiptsSha256: sha256,
    observationsSha256: sha256,
    operationsSha256: sha256,
  })
  .strict();
export const nativeContextLedgerResumeExpectedSchema = z
  .object({
    revision: z.literal(1),
    generation: z.literal(0),
    policyVersion: z.literal(0),
    historyVersion: sha256,
    currentSegmentId: z.literal("initial"),
    systemMessageSha256: z.array(sha256).length(3),
    shellNoticeSha256: sha256.nullable(),
    shellDialect: z.enum(["cmd", "posix", "git-bash", "legacy-shell"]),
    shellSource: z.enum(["auto-detected", "user-config", "legacy-fallback"]),
    skillGuidance: z.boolean(),
  })
  .strict();

/** 合成账本只验分页和呈现；其中的数字不代表实际调用了 3000 次 Provider。 */
export const nativeContextLedgerManifestSchema = z
  .object({
    version: z.literal(1),
    caseId: z.literal("NCTX-58"),
    synthetic: z.literal(true),
    namespace: z.string().regex(/^nctx-ledger-[a-f0-9-]{36}$/),
    sessionId: z.string().min(1),
    title: z.string().min(1),
    model: nativeContextModelSchema,
    sandboxRoot: z.string().min(1),
    homeDir: z.string().min(1),
    workspacePath: z.string().min(1),
    dbPath: z.string().min(1),
    revision: z.literal(0),
    generation: z.literal(0),
    historyVersion: z.string().regex(/^[a-f0-9]{64}$/),
    currentSegmentId: z.literal("initial"),
    hostPreferences: nativeContextLedgerHostPreferencesSchema,
    seedFacts: nativeContextLedgerSeedFactsSchema,
    resumeExpected: nativeContextLedgerResumeExpectedSchema,
    counts: z.object({
      observations: z.literal(3000),
      main: z.literal(2970),
      maintenance: z.literal(15),
      decision: z.literal(15),
      operations: z.literal(15),
      messages: z.literal(5940),
    }),
    sentinels: z.object({
      first: nativeContextObservationSchema,
      last: nativeContextObservationSchema,
      peak: nativeContextObservationSchema,
      zero: nativeContextObservationSchema,
      increase: nativeContextObservationSchema,
      selected: nativeContextObservationSchema,
      unknown: nativeContextObservationSchema,
      event: nativeContextObservationSchema,
    }),
    unknownGaps: z.array(z.object({ first: z.number().int(), last: z.number().int() })).length(2),
    eventPointIds: z.array(z.string()).min(1),
    operations: z.array(nativeContextOperationSummarySchema).length(15),
  })
  .strict();

export type NativeContextLedgerManifest = z.infer<typeof nativeContextLedgerManifestSchema>;
export type NativeContextLedgerSentinel = keyof NativeContextLedgerManifest["sentinels"];
export const nativeContextLedgerSeedManifestSchema = nativeContextLedgerManifestSchema.omit({
  hostPreferences: true,
  seedFacts: true,
  resumeExpected: true,
});
export type NativeContextLedgerSeedManifest = z.infer<typeof nativeContextLedgerSeedManifestSchema>;
