import type {
  WorkspaceAliasReport,
  WorkspaceAliasRestoreRequest,
  WorkspaceAliasWriterLease,
} from "../contract.js";
import { WorkspaceAliasError } from "../contract.js";
import type { AliasJob, NodeLayout, NodeWorkspaceAliasOptions } from "./inspection.js";
import { assertAuthority, recoverOwnedJournal } from "./execution.js";
import {
  begin,
  databaseDigest,
  databaseImage,
  databaseJournal,
  readDatabase,
  withDatabaseWrite,
  writeImage,
} from "./database.js";
import { readAliases, readJob, saveJob, withOwner } from "./ledger.js";
import { expectedConfigState, validateArtifacts, verifiedConfigIndex } from "./artifacts.js";
import { runRename } from "./configs.js";
import { hash, operationError } from "./files.js";

async function assertAliasState(locations: NodeLayout, job: AliasJob): Promise<void> {
  const original = job.plan.inspection.aliases;
  const sameScope = (alias: (typeof original)[number]) =>
    alias.sourceServerId === job.report.sourceServerId &&
    alias.normalizedPath === job.plan.inspection.normalizedPath;
  const published = [
    ...original.filter((alias) => !sameScope(alias)),
    {
      sourceServerId: job.report.sourceServerId,
      normalizedPath: job.plan.inspection.normalizedPath,
      canonicalKey: job.report.canonicalKey,
      jobId: job.report.jobId,
    },
  ].sort(
    (a, b) =>
      a.sourceServerId.localeCompare(b.sourceServerId) ||
      a.normalizedPath.localeCompare(b.normalizedPath),
  );
  const current = await readAliases(locations);
  // 其它alias的新增也是后来写入，恢复不能只验收当前路径后回退全局控制事实。
  if (hash(current) !== hash(original) && hash(current) !== hash(published))
    throw new WorkspaceAliasError("state-diverged");
  if (job.report.phase === "completed" && hash(current) !== hash(published))
    throw new WorkspaceAliasError("state-diverged");
}
async function verifyDatabaseState(
  locations: NodeLayout,
  job: AliasJob,
  restoring: boolean,
  signal?: AbortSignal,
): Promise<Record<"host" | "cli", "before" | "after">> {
  const result = {} as Record<"host" | "cli", "before" | "after">;
  const phases = [
    "approved",
    "backups-created",
    "host-merged",
    "cli-merged",
    "configs-merged",
    "completed",
  ];
  for (const kind of ["host", "cli"] as const) {
    const original = databaseDigest(job.plan.inspection[kind]);
    const after = databaseDigest(job.output[kind]);
    const current = databaseDigest(await readDatabase(locations.root, locations[kind], signal));
    const unchanged = original === after;
    const state = current === original ? "before" : current === after ? "after" : null;
    if (!state) throw new WorkspaceAliasError("state-diverged");
    if (!unchanged) {
      if (!restoring) {
        const committed = phases.indexOf(job.report.phase) >= (kind === "host" ? 2 : 3);
        if (
          state !== (committed ? "after" : "before") &&
          !(job.intent === kind && state === "after")
        )
          throw new WorkspaceAliasError("state-diverged");
      } else {
        if (!job.restoreInitial) throw new WorkspaceAliasError("state-diverged");
        const restored = job.restoreCommitted?.includes(kind) ?? false;
        const expected = restored ? "before" : job.restoreInitial[kind];
        // 恰等于original不能证明恢复已发生，必须有本次恢复COMMIT前持久化的intent。
        if (state !== expected && !(state === "before" && job.restoreIntent === kind))
          throw new WorkspaceAliasError("state-diverged");
      }
    }
    result[kind] = state;
  }
  return result;
}
export async function restoreJob(
  locations: NodeLayout,
  options: NodeWorkspaceAliasOptions,
  request: WorkspaceAliasRestoreRequest,
  signal?: AbortSignal,
): Promise<WorkspaceAliasReport> {
  if (request.writersStopped !== true) throw new WorkspaceAliasError("active-owner");
  return withOwner(
    locations,
    async () => {
      const job = await readJob(locations, request.jobId);
      if (!job || job.report.revision !== request.expectedRevision)
        throw new WorkspaceAliasError("revision-stale");
      if (job.report.phase === "restored") return job.report;
      const lease = await options.authority.acquireStoppedWriters(
        job.plan.inspection.scope,
        job.report.jobId,
        signal,
      );
      try {
        await assertAuthority(options, job, lease, signal);
        const artifacts = await validateArtifacts(locations, job, signal);
        if (job.journalIntent)
          await recoverOwnedJournal(
            locations,
            job,
            options,
            lease,
            job.report.phase === "restoring" ? "restore" : "merge",
            signal,
          );
        await assertAliasState(locations, job);
        const restoring = job.report.phase === "restoring";
        const initial = await verifyDatabaseState(locations, job, restoring, signal);
        const configIndex = await verifiedConfigIndex(
          locations,
          job,
          artifacts.operations,
          restoring,
          signal,
        );
        if (!restoring) {
          job.configIndex = configIndex;
          delete job.renameIntent;
          delete job.journalIntent;
          delete job.intent;
          job.restoreInitial = initial;
          job.restoreCommitted = [];
          job.report.phase = "restoring";
          job.report.status = "restoring";
          job.restoreStep = "configs";
          delete job.report.errorCode;
          await saveJob(locations, job);
          await options.afterPhaseCommitted?.("restoring", job.report.jobId);
        }
        while (job.restoreConfigIndex < job.configIndex) {
          await assertAuthority(options, job, lease, signal);
          const index = job.configIndex - job.restoreConfigIndex - 1;
          const forward = artifacts.operations[index]!;
          if (
            job.renameIntent &&
            (job.renameIntent.direction !== "restore" || job.renameIntent.index !== index)
          )
            throw new WorkspaceAliasError("state-diverged");
          job.renameIntent = { direction: "restore", index };
          await saveJob(locations, job);
          await options.afterPhaseCommitted?.("config-rename-intent", job.report.jobId);
          await runRename(
            locations.root,
            { from: forward.to, to: forward.from, image: forward.image },
            signal,
            () => assertAuthority(options, job, lease, signal),
          );
          await expectedConfigState(locations, job, index, artifacts.operations, signal);
          await options.afterPhaseCommitted?.("config-renamed", job.report.jobId);
          job.restoreConfigIndex++;
          delete job.renameIntent;
          await saveJob(locations, job);
          await options.afterPhaseCommitted?.("config-rename", job.report.jobId);
        }
        await expectedConfigState(locations, job, 0, artifacts.operations, signal);
        for (const kind of ["cli", "host"] as const) {
          await assertAuthority(options, job, lease, signal);
          await restoreDatabase(locations, job, kind, options, lease, signal);
          job.restoreStep = kind;
          job.restoreCommitted = [...new Set([...(job.restoreCommitted ?? []), kind])];
          // 重入时CLI已恢复不能清掉尚待认领的Host COMMIT intent。
          if (job.restoreIntent === kind) delete job.restoreIntent;
          if (job.journalIntent?.kind === kind) delete job.journalIntent;
          await saveJob(locations, job);
        }
        await verifyDatabaseState(locations, job, true, signal);
        for (const kind of ["host", "cli"] as const)
          if (
            databaseDigest(await readDatabase(locations.root, locations[kind], signal)) !==
            databaseDigest(job.plan.inspection[kind])
          )
            throw new WorkspaceAliasError("state-diverged");
        await expectedConfigState(locations, job, 0, artifacts.operations, signal);
        await assertAliasState(locations, job);
        await assertAuthority(options, job, lease, signal);
        job.report.phase = "restored";
        job.report.status = "restored";
        delete job.report.errorCode;
        await saveJob(locations, job, "restore");
        await options.afterPhaseCommitted?.("restored", job.report.jobId);
        return job.report;
      } catch (error) {
        const failure = signal?.aborted
          ? new WorkspaceAliasError("cancelled")
          : operationError(error);
        if (job.report.phase !== "restored") {
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
async function restoreDatabase(
  locations: NodeLayout,
  job: AliasJob,
  kind: "host" | "cli",
  options: NodeWorkspaceAliasOptions,
  lease: WorkspaceAliasWriterLease,
  signal?: AbortSignal,
): Promise<void> {
  await verifyDatabaseState(locations, job, true, signal);
  const original = job.plan.inspection[kind];
  const current = await readDatabase(locations.root, locations[kind], signal);
  if (databaseDigest(current) === databaseDigest(original)) return;
  if (!original.exists || databaseDigest(current) !== databaseDigest(job.output[kind]))
    throw new WorkspaceAliasError("state-diverged");
  await withDatabaseWrite(locations.root, locations[kind], async (db, identity, assertCurrent) => {
    if (identity !== original.identity) throw new WorkspaceAliasError("state-diverged");
    await begin(db, signal);
    const before = await databaseImage(db, identity, signal);
    if (databaseDigest(before) !== databaseDigest(job.output[kind]))
      throw new WorkspaceAliasError("state-diverged");
    await assertAuthority(options, job, lease, signal);
    await writeImage(db, before, original, signal);
    if (databaseDigest(await databaseImage(db, identity, signal)) !== databaseDigest(original))
      throw new WorkspaceAliasError("state-diverged");
    job.restoreIntent = kind;
    job.journalIntent = {
      kind,
      direction: "restore",
      image: await databaseJournal(locations.root, locations[kind], signal),
    };
    await saveJob(locations, job);
    await options.afterPhaseCommitted?.(`restore-${kind}-intent`, job.report.jobId);
    await assertCurrent();
    await assertAuthority(options, job, lease, signal);
    db.exec("COMMIT");
    await options.afterPhaseCommitted?.(`restore-${kind}-committed`, job.report.jobId);
  });
}
