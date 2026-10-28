import type {
  WorkspaceAliasJobRequest,
  WorkspaceAliasReport,
  WorkspaceAliasWriterLease,
} from "../contract.js";
import { WorkspaceAliasError, workspaceAliasAuthoritySnapshotSchema } from "../contract.js";
import { verifiedKeys } from "../domain/identity.js";
import type { AliasJob, NodeLayout, NodeWorkspaceAliasOptions } from "./inspection.js";
import {
  begin,
  databaseDigest,
  databaseImage,
  databaseJournal,
  recoverDatabaseJournal,
  readDatabase,
  withDatabaseWrite,
  writeImage,
} from "./database.js";
import { readAliases, readJob, saveJob, withOwner } from "./ledger.js";
import { configDigest, readConfig } from "./configs.js";
import {
  createArtifacts,
  expectedConfigState,
  mergeConfigs,
  validateArtifacts,
  verifiedConfigIndex,
} from "./artifacts.js";
import { inspectWorkspace } from "./inspection.js";
import { buildPlan } from "../domain/plan.js";
import { hash, operationError, rootIdentity } from "./files.js";

export async function assertAuthority(
  options: NodeWorkspaceAliasOptions,
  job: AliasJob,
  lease: WorkspaceAliasWriterLease,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  await lease.assertCurrent();
  const parsed = workspaceAliasAuthoritySnapshotSchema.safeParse(
    await options.authority.inspect(job.plan.inspection.scope, signal),
  );
  if (!parsed.success) throw new WorkspaceAliasError("source-stale");
  const source = parsed.data;
  let keys: string[];
  try {
    keys = verifiedKeys(
      source.sourceServerId,
      job.report.workspacePath,
      source.legacyWorkspaceKeys,
    );
  } catch {
    throw new WorkspaceAliasError("source-stale");
  }
  // 同一generation不能掩盖线路归属或CLI项目计算结果改变，COMMIT/rename前必须复核完整冻结authority。
  if (
    source.sourceServerId !== job.report.sourceServerId ||
    source.generation !== job.report.sourceGeneration ||
    source.projectId !== job.plan.inspection.projectId ||
    hash(keys) !== hash(job.plan.inspection.allowedKeys)
  )
    throw new WorkspaceAliasError("source-stale");
  if ((await rootIdentity(options.dataRoot)) !== job.plan.inspection.rootGeneration)
    throw new WorkspaceAliasError("state-diverged");
  signal?.throwIfAborted();
  await lease.assertCurrent();
}
async function currentStage(
  locations: NodeLayout,
  job: AliasJob,
  kind: "host" | "cli",
  signal?: AbortSignal,
): Promise<"before" | "after"> {
  const current = await readDatabase(locations.root, locations[kind], signal);
  const digest = databaseDigest(current);
  if (digest === databaseDigest(job.output[kind])) return "after";
  if (digest === databaseDigest(job.plan.inspection[kind])) return "before";
  throw new WorkspaceAliasError("state-diverged");
}
async function commitPhase(
  locations: NodeLayout,
  job: AliasJob,
  options: NodeWorkspaceAliasOptions,
  phase: WorkspaceAliasReport["phase"],
  signal?: AbortSignal,
): Promise<void> {
  job.report.phase = phase;
  if (phase === "completed") job.report.status = "completed";
  await saveJob(
    locations,
    job,
    phase === "completed"
      ? {
          sourceServerId: job.report.sourceServerId,
          normalizedPath: job.plan.inspection.normalizedPath,
          canonicalKey: job.report.canonicalKey,
          jobId: job.report.jobId,
        }
      : undefined,
  );
  await options.afterPhaseCommitted?.(phase, job.report.jobId);
  signal?.throwIfAborted();
}
async function mergeDatabase(
  locations: NodeLayout,
  job: AliasJob,
  kind: "host" | "cli",
  lease: WorkspaceAliasWriterLease,
  options: NodeWorkspaceAliasOptions,
  signal?: AbortSignal,
): Promise<void> {
  if (!job.plan.inspection[kind].exists) {
    if ((await readDatabase(locations.root, locations[kind], signal)).exists)
      throw new WorkspaceAliasError("state-diverged");
    return;
  }
  const state = await currentStage(locations, job, kind, signal);
  if (
    state === "after" &&
    job.intent !== kind &&
    databaseDigest(job.output[kind]) !== databaseDigest(job.plan.inspection[kind])
  )
    throw new WorkspaceAliasError("state-diverged");
  if (state === "after") return;
  await withDatabaseWrite(locations.root, locations[kind], async (db, identity, assertCurrent) => {
    if (identity !== job.plan.inspection[kind].identity)
      throw new WorkspaceAliasError("state-diverged");
    await begin(db, signal);
    const before = await databaseImage(db, identity, signal);
    if (databaseDigest(before) !== databaseDigest(job.plan.inspection[kind]))
      throw new WorkspaceAliasError("state-diverged");
    await assertAuthority(options, job, lease, signal);
    await writeImage(db, before, job.output[kind], signal);
    const after = await databaseImage(db, before.identity, signal);
    if (databaseDigest(after) !== databaseDigest(job.output[kind]))
      throw new WorkspaceAliasError("state-diverged");
    await assertAuthority(options, job, lease, signal);
    job.intent = kind;
    job.journalIntent = {
      kind,
      direction: "merge",
      image: await databaseJournal(locations.root, locations[kind], signal),
    };
    await saveJob(locations, job);
    await options.afterPhaseCommitted?.(`${kind}-intent`, job.report.jobId);
    signal?.throwIfAborted();
    await assertCurrent();
    await assertAuthority(options, job, lease, signal);
    db.exec("COMMIT");
    await options.afterPhaseCommitted?.(`${kind}-committed`, job.report.jobId);
  });
}
export async function recoverOwnedJournal(
  locations: NodeLayout,
  job: AliasJob,
  options: NodeWorkspaceAliasOptions,
  lease: WorkspaceAliasWriterLease,
  direction: "merge" | "restore",
  signal?: AbortSignal,
): Promise<void> {
  const intent = job.journalIntent;
  if (!intent) return;
  if (
    intent.direction !== direction ||
    (direction === "merge" ? job.intent : job.restoreIntent) !== intent.kind
  )
    throw new WorkspaceAliasError("state-diverged");
  await validateArtifacts(locations, job, signal);
  await recoverDatabaseJournal(
    locations.root,
    locations[intent.kind],
    intent.image,
    direction === "merge" ? job.plan.inspection[intent.kind] : job.output[intent.kind],
    () => assertAuthority(options, job, lease, signal),
    signal,
  );
}
export async function executeJob(
  locations: NodeLayout,
  options: NodeWorkspaceAliasOptions,
  request: WorkspaceAliasJobRequest,
  signal?: AbortSignal,
): Promise<WorkspaceAliasReport> {
  return withOwner(
    locations,
    async () => {
      const job = await readJob(locations, request.jobId);
      if (!job || job.report.revision !== request.expectedRevision)
        throw new WorkspaceAliasError("revision-stale");
      if (job.report.status === "completed") return job.report;
      if (job.report.phase === "restored" || job.report.phase === "restoring")
        throw new WorkspaceAliasError("state-diverged");
      const lease = await options.authority.acquireStoppedWriters(
        job.plan.inspection.scope,
        job.report.jobId,
        signal,
      );
      try {
        await assertAuthority(options, job, lease, signal);
        await recoverOwnedJournal(locations, job, options, lease, "merge", signal);
        const aliases = await readAliases(locations);
        if (hash(aliases) !== hash(job.plan.inspection.aliases))
          throw new WorkspaceAliasError("state-diverged");
        job.report.status = "running";
        delete job.report.errorCode;
        await saveJob(locations, job);
        const phases = [
          "approved",
          "backups-created",
          "host-merged",
          "cli-merged",
          "configs-merged",
          "completed",
        ];
        if (job.report.phase === "approved") {
          const inspection = await inspectWorkspace(
            options,
            job.plan.inspection.scope,
            aliases,
            signal,
          );
          if (
            buildPlan(
              inspection,
              { hash },
              job.plan.preview.createdAt,
              options.approvalTtlMs ?? 5 * 60_000,
            ).preview.planHash !== job.report.planHash
          )
            throw new WorkspaceAliasError("plan-stale");
          for (const kind of ["host", "cli"] as const)
            if (
              (await currentStage(locations, job, kind, signal)) !== "before" &&
              databaseDigest(job.plan.inspection[kind]) !== databaseDigest(job.output[kind])
            )
              throw new WorkspaceAliasError("plan-stale");
          for (const image of job.plan.inspection.configs)
            if (
              configDigest(await readConfig(locations.root, image, signal)) !== configDigest(image)
            )
              throw new WorkspaceAliasError("plan-stale");
          await createArtifacts(
            locations,
            job,
            options,
            () => assertAuthority(options, job, lease, signal),
            signal,
          );
          const afterBackup = await inspectWorkspace(
            options,
            job.plan.inspection.scope,
            aliases,
            signal,
          );
          if (hash(afterBackup) !== job.plan.preview.candidateVersion)
            throw new WorkspaceAliasError("plan-stale");
          await commitPhase(locations, job, options, "backups-created", signal);
        }
        const artifacts = await validateArtifacts(locations, job, signal);
        // 每个阶段先验收所有未/已提交介质，不能写完Host才发现CLI或配置出现后来数据。
        const effectivePhase = [
          "approved",
          "backups-created",
          "host-merged",
          "cli-merged",
          "configs-merged",
          "completed",
        ].indexOf(job.report.phase);
        for (const kind of ["host", "cli"] as const) {
          const expectedAfter = effectivePhase >= (kind === "host" ? 2 : 3);
          const state = await currentStage(locations, job, kind, signal);
          const unchanged =
            databaseDigest(job.output[kind]) === databaseDigest(job.plan.inspection[kind]);
          if (
            !unchanged &&
            state !== (expectedAfter ? "after" : "before") &&
            !(job.intent === kind && state === "after")
          )
            throw new WorkspaceAliasError("state-diverged");
        }
        await verifiedConfigIndex(locations, job, artifacts.operations, false, signal);
        for (const kind of ["host", "cli"] as const) {
          const phase = kind === "host" ? "host-merged" : "cli-merged";
          await assertAuthority(options, job, lease, signal);
          if (phases.indexOf(job.report.phase) < phases.indexOf(phase)) {
            await mergeDatabase(locations, job, kind, lease, options, signal);
            delete job.intent;
            if (job.journalIntent?.kind === kind) delete job.journalIntent;
            await commitPhase(locations, job, options, phase, signal);
          } else if ((await currentStage(locations, job, kind, signal)) !== "after")
            throw new WorkspaceAliasError("state-diverged");
        }
        await assertAuthority(options, job, lease, signal);
        if (job.report.phase !== "configs-merged") {
          await mergeConfigs(
            locations,
            job,
            artifacts,
            options,
            () => assertAuthority(options, job, lease, signal),
            signal,
          );
          await commitPhase(locations, job, options, "configs-merged", signal);
        }
        await expectedConfigState(
          locations,
          job,
          artifacts.operations.length,
          artifacts.operations,
          signal,
        );
        for (const kind of ["host", "cli"] as const)
          if ((await currentStage(locations, job, kind, signal)) !== "after")
            throw new WorkspaceAliasError("state-diverged");
        await assertAuthority(options, job, lease, signal);
        await commitPhase(locations, job, options, "completed", signal);
        return job.report;
      } catch (error) {
        const failure = signal?.aborted
          ? new WorkspaceAliasError("cancelled", { cause: error })
          : operationError(error);
        if (job.report.phase !== "completed") {
          job.report.status = failure.code === "cancelled" ? "cancelled" : "failed";
          job.report.errorCode = failure.code;
          await saveJob(locations, job);
        }
        throw failure;
      } finally {
        await lease.release();
      }
    },
    signal,
  );
}
