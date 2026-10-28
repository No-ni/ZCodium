import { z } from "zod";

const id = z.string().regex(/^[A-Za-z0-9_-]+$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().min(1).max(4096);
// identity含Source前缀，不能与原始路径共用长度上限。
const workspaceKey = z.string().min(1).max(8192);
export const workspaceAliasScopeSchema = z
  .object({ sourceServerId: id, workspacePath: text })
  .strict();
export type WorkspaceAliasScope = z.infer<typeof workspaceAliasScopeSchema>;

export const workspaceAliasPhases = [
  "approved",
  "backups-created",
  "host-merged",
  "cli-merged",
  "configs-merged",
  "completed",
  "restoring",
  "restored",
] as const;
export type WorkspaceAliasPhase = (typeof workspaceAliasPhases)[number];
export const workspaceAliasErrorCodes = [
  "boundary-rejected",
  "source-stale",
  "plan-stale",
  "confirmation-required",
  "collision-unresolved",
  "active-owner",
  "schema-incompatible",
  "snapshot-stale",
  "snapshot-unproven",
  "backup-failed",
  "state-diverged",
  "permission-denied",
  "storage-full",
  "io-failed",
  "cancelled",
  "revision-stale",
] as const;
export type WorkspaceAliasErrorCode = (typeof workspaceAliasErrorCodes)[number];
export class WorkspaceAliasError extends Error {
  constructor(
    readonly code: WorkspaceAliasErrorCode,
    options?: ErrorOptions,
  ) {
    super(`Source workspace operation rejected: ${code}`, options);
    this.name = "WorkspaceAliasError";
  }
}
const collisionSchema = z
  .object({
    collisionId: hash,
    kind: z.enum(["task", "member", "order", "bootstrap", "config"]),
    subject: text,
    sources: z.array(z.object({ workspaceKey: workspaceKey, valueHash: hash }).strict()).min(2),
  })
  .strict();
export type WorkspaceAliasCollision = z.infer<typeof collisionSchema>;
export const workspaceAliasPreviewSchema = workspaceAliasScopeSchema
  .extend({
    schemaVersion: z.literal(1),
    sourceGeneration: z.number().int().nonnegative(),
    normalizedPath: workspaceKey,
    stableIdentity: workspaceKey,
    canonicalKey: workspaceKey,
    state: z.enum(["new", "single", "confirmation-required", "blocked", "resolved"]),
    candidateVersion: hash,
    planHash: hash,
    candidates: z.array(
      z
        .object({
          workspaceKey: workspaceKey,
          hostRows: z.number().int().nonnegative(),
          sessionRows: z.number().int().nonnegative(),
          configEntries: z.number().int().nonnegative(),
          valueHash: hash,
        })
        .strict(),
    ),
    collisions: z.array(collisionSchema),
    blocks: z.array(z.object({ code: z.enum(workspaceAliasErrorCodes), subject: text }).strict()),
    excludedKeys: z.array(workspaceKey),
    createdAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    confirmationToken: text,
  })
  .strict();
export type WorkspaceAliasPreview = z.infer<typeof workspaceAliasPreviewSchema>;
export const workspaceAliasConfirmationSchema = workspaceAliasScopeSchema
  .extend({
    sourceGeneration: z.number().int().nonnegative(),
    candidateVersion: hash,
    planHash: hash,
    confirmationToken: text,
    acknowledgeMerge: z.literal(true),
    canonicalKey: workspaceKey,
    choices: z.array(z.object({ collisionId: hash, sourceKey: workspaceKey }).strict()),
  })
  .strict();
export type WorkspaceAliasConfirmation = z.infer<typeof workspaceAliasConfirmationSchema>;
export const workspaceAliasJobRequestSchema = z
  .object({ jobId: id, expectedRevision: z.number().int().nonnegative() })
  .strict();
export type WorkspaceAliasJobRequest = z.infer<typeof workspaceAliasJobRequestSchema>;
export const workspaceAliasRestoreRequestSchema = workspaceAliasJobRequestSchema
  .extend({ writersStopped: z.literal(true) })
  .strict();
export type WorkspaceAliasRestoreRequest = z.infer<typeof workspaceAliasRestoreRequestSchema>;
export const workspaceAliasReportSchema = workspaceAliasScopeSchema
  .extend({
    jobId: id,
    revision: z.number().int().nonnegative(),
    sourceGeneration: z.number().int().nonnegative(),
    canonicalKey: workspaceKey,
    mergedKeys: z.array(workspaceKey),
    planHash: hash,
    phase: z.enum(workspaceAliasPhases),
    status: z.enum([
      "approved",
      "running",
      "failed",
      "cancelled",
      "completed",
      "restoring",
      "restored",
    ]),
    errorCode: z.enum(workspaceAliasErrorCodes).optional(),
  })
  .strict();
export type WorkspaceAliasReport = z.infer<typeof workspaceAliasReportSchema>;
export interface WorkspaceAliasResolved {
  state: "ready" | "confirmation-required" | "blocked";
  stableIdentity: string;
  canonicalKey?: string;
  persisted: boolean;
  preview: WorkspaceAliasPreview;
}
export const workspaceAliasAuthoritySnapshotSchema = z
  .object({
    sourceServerId: id,
    generation: z.number().int().nonnegative().safe(),
    legacyWorkspaceKeys: z.array(workspaceKey),
    projectId: text,
  })
  .strict();
export type WorkspaceAliasAuthoritySnapshot = Omit<
  z.infer<typeof workspaceAliasAuthoritySnapshotSchema>,
  "legacyWorkspaceKeys"
> & { legacyWorkspaceKeys: readonly string[] };
export interface WorkspaceAliasAuthority {
  /** 只由已鉴权 Source owner 提供；客户端不能传入旧线路或根目录。 */
  inspect(
    scope: WorkspaceAliasScope,
    signal?: AbortSignal,
  ): Promise<WorkspaceAliasAuthoritySnapshot>;
  /** 必须停止同一dataRoot两个库及全部声明配置根的所有进程写者；不是workspace级布尔确认。 */
  acquireStoppedWriters(
    scope: WorkspaceAliasScope,
    jobId: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceAliasWriterLease>;
}
export interface WorkspaceAliasWriterLease {
  assertCurrent(): Promise<void>;
  release(): Promise<void>;
}
export interface WorkspaceAliasCallOptions {
  signal?: AbortSignal;
}

const snapshotFileObservationSchema = z.discriminatedUnion("exists", [
  z.object({ exists: z.literal(false) }).strict(),
  z
    .object({
      exists: z.literal(true),
      identity: hash,
      byteLength: z.number().int().nonnegative().safe(),
      byteHash: hash,
      changeGeneration: hash,
    })
    .strict(),
]);
export const workspaceCommittedSnapshotEvidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    rootGeneration: hash,
    databasePathHash: hash,
    files: z
      .object({
        database: snapshotFileObservationSchema,
        wal: snapshotFileObservationSchema,
        shm: snapshotFileObservationSchema,
      })
      .strict(),
    committed: z
      .object({
        pageSize: z.number().int().min(512).max(65536),
        databasePages: z.number().int().positive().safe(),
        wal: z
          .object({
            salt: z.string().regex(/^[a-f0-9]{16}$/),
            checksum: z.tuple([
              z.number().int().min(0).max(0xffffffff),
              z.number().int().min(0).max(0xffffffff),
            ]),
            lastCommitFrame: z.number().int().positive().safe(),
          })
          .strict()
          .nullable(),
      })
      .strict(),
    consistency: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("native-read-barrier"), barrierGeneration: hash }).strict(),
      z
        .object({
          kind: z.literal("atomic-tuple-epoch"),
          captureGeneration: hash,
          sourceEpoch: z.string().regex(/^(0|[1-9][0-9]*)$/),
        })
        .strict(),
    ]),
  })
  .strict();
export type WorkspaceCommittedSnapshotEvidence = z.infer<
  typeof workspaceCommittedSnapshotEvidenceSchema
>;
export interface WorkspaceCommittedSnapshotRequest {
  dataRoot: string;
  databasePath: string;
  signal?: AbortSignal;
}
export interface WorkspaceCommittedSnapshot {
  /** 仅隔离副本路径；consumer不能保存它或在withSnapshot生命周期外使用。 */
  databasePath: string;
  evidence: WorkspaceCommittedSnapshotEvidence;
}
export interface WorkspaceCommittedSnapshotPort {
  /** 证据schema只约束形状；可信后端必须另外证明整个捕获区间，没有该能力时拒绝。 */
  withSnapshot<T>(
    request: WorkspaceCommittedSnapshotRequest,
    consumer: (snapshot: WorkspaceCommittedSnapshot) => Promise<T>,
  ): Promise<T>;
}

export interface SourceServerWorkspaceService {
  preview(
    scope: WorkspaceAliasScope,
    options?: WorkspaceAliasCallOptions,
  ): Promise<WorkspaceAliasPreview>;
  getResolvedWorkspace(
    scope: WorkspaceAliasScope,
    options?: WorkspaceAliasCallOptions,
  ): Promise<WorkspaceAliasResolved>;
  confirm(
    request: WorkspaceAliasConfirmation,
    options?: WorkspaceAliasCallOptions,
  ): Promise<WorkspaceAliasReport>;
  execute(
    request: WorkspaceAliasJobRequest,
    options?: WorkspaceAliasCallOptions,
  ): Promise<WorkspaceAliasReport>;
  retry(
    request: WorkspaceAliasJobRequest,
    options?: WorkspaceAliasCallOptions,
  ): Promise<WorkspaceAliasReport>;
  report(jobId: string): Promise<WorkspaceAliasReport | null>;
  restore(
    request: WorkspaceAliasRestoreRequest,
    options?: WorkspaceAliasCallOptions,
  ): Promise<WorkspaceAliasReport>;
}
