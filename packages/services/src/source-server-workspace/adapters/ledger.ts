import { DatabaseSync } from "node:sqlite";
import { withShortBusyTimeout } from "@zcode/shared/sqlite-migrations";
import { WorkspaceAliasError, workspaceAliasReportSchema } from "../contract.js";
import type { AliasImage } from "../domain/images.js";
import type { AliasJob, NodeLayout } from "./inspection.js";
import { assertRoot, assertSafePath, hash, makeDirectory, openSafe } from "./files.js";
import { open } from "node:fs/promises";
import { deriveMerge } from "../domain/merge.js";
import { buildPlan } from "../domain/plan.js";
import { configOperations } from "./configs.js";
import { workspaceAliasPreviewSchema, workspaceAliasJobRequestSchema } from "../contract.js";
import { begin, guardDatabase } from "./database.js";
import { dirname } from "node:path";

const operations = new Map<string, Promise<void>>();
export async function withOwner<T>(
  locations: NodeLayout,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const canonical = await assertRoot(locations.root);
  const key = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  const previous = operations.get(key) ?? Promise.resolve();
  let release!: () => void;
  const barrier = new Promise<void>((done) => {
    release = done;
  });
  operations.set(
    key,
    previous.then(() => barrier),
  );
  try {
    await previous;
    signal?.throwIfAborted();
    await makeDirectory(locations.root, dirname(locations.owner));
    if (!(await assertSafePath(locations.root, locations.owner, true))) {
      try {
        const reservation = await open(locations.owner, "wx", 0o600);
        await reservation.close();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    const file = await openSafe(locations.root, locations.owner, true);
    let owner: DatabaseSync | undefined;
    try {
      owner = new DatabaseSync(locations.owner);
      return await withShortBusyTimeout(owner, async () => {
        await begin(owner!, signal);
        try {
          const value = await operation();
          await file.assertCurrent();
          owner!.exec("COMMIT");
          return value;
        } catch (error) {
          if (owner!.isTransaction) owner!.exec("ROLLBACK");
          throw error;
        }
      });
    } finally {
      owner?.close();
      await file.handle.close();
    }
  } finally {
    release();
    const active = operations.get(key);
    void active?.then(() => {
      if (operations.get(key) === active) operations.delete(key);
    });
  }
}
const schema = `CREATE TABLE IF NOT EXISTS alias_job(job_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, source_id TEXT NOT NULL,path TEXT NOT NULL,data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workspace_alias(source_id TEXT NOT NULL,path TEXT NOT NULL,canonical_key TEXT NOT NULL UNIQUE,job_id TEXT NOT NULL,PRIMARY KEY(source_id,path));`;
export async function withLedger<T>(
  locations: NodeLayout,
  write: boolean,
  operation: (db: DatabaseSync) => T,
): Promise<T | null> {
  const exists = await assertSafePath(locations.root, locations.ledger, true);
  if (!exists && !write) return null;
  if (!exists) {
    await makeDirectory(locations.root, dirname(locations.ledger));
    const reservation = await open(locations.ledger, "wx", 0o600);
    await reservation.close();
  }
  const file = await guardDatabase(locations.root, locations.ledger, write);
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(locations.ledger, { readOnly: !write });
    if (write) db.exec(schema);
    else db.exec("BEGIN");
    const result = operation(db);
    await file.assertCurrent();
    return result;
  } finally {
    if (db?.isTransaction) db.exec("ROLLBACK");
    db?.close();
    await file.handle.close();
  }
}
export async function readAliases(locations: NodeLayout): Promise<AliasImage[]> {
  return (
    (await withLedger(locations, false, (db) =>
      db
        .prepare(
          "SELECT source_id, path, canonical_key, job_id FROM workspace_alias ORDER BY source_id,path",
        )
        .all()
        .map((row) => ({
          sourceServerId: String(row.source_id),
          normalizedPath: String(row.path),
          canonicalKey: String(row.canonical_key),
          jobId: String(row.job_id),
        })),
    )) ?? []
  );
}
function validateJob(job: AliasJob): AliasJob {
  try {
    workspaceAliasReportSchema.parse(job.report);
    workspaceAliasPreviewSchema.parse(job.plan.preview);
    const frozen = job.plan.inspection;
    const rebuilt = buildPlan(
      frozen,
      { hash },
      job.plan.preview.createdAt,
      job.plan.preview.expiresAt - job.plan.preview.createdAt,
    );
    const normalize = (plan: AliasJob["plan"]) => ({
      ...plan,
      preview: { ...plan.preview, confirmationToken: "unsigned" },
    });
    if (
      hash(normalize(rebuilt)) !== hash(normalize(job.plan)) ||
      job.report.planHash !== rebuilt.preview.planHash ||
      job.report.sourceServerId !== frozen.scope.sourceServerId ||
      job.report.workspacePath !== frozen.scope.workspacePath ||
      job.report.sourceGeneration !== frozen.generation ||
      job.report.canonicalKey !== rebuilt.canonicalKey ||
      hash(job.report.mergedKeys) !==
        hash(rebuilt.candidates.filter((key) => key !== rebuilt.canonicalKey))
    )
      throw new WorkspaceAliasError("state-diverged");
    const choices = new Map(job.choices.map((choice) => [choice.collisionId, choice.sourceKey]));
    if (
      choices.size !== job.choices.length ||
      choices.size !== rebuilt.collisions.length ||
      rebuilt.collisions.some(
        (collision) =>
          !collision.sources.some(
            (source) => source.workspaceKey === choices.get(collision.collisionId),
          ),
      )
    )
      throw new WorkspaceAliasError("state-diverged");
    const derived = deriveMerge(
      frozen,
      rebuilt.canonicalKey,
      rebuilt.candidates,
      { hash },
      choices,
    );
    if (hash(derived.output) !== hash(job.output) || derived.blocks.length)
      throw new WorkspaceAliasError("state-diverged");
    const count = configOperations("validated-job", frozen.configs, job.output.configs).length;
    const phases = [
      "approved",
      "backups-created",
      "host-merged",
      "cli-merged",
      "configs-merged",
      "completed",
    ];
    const phase = phases.indexOf(job.report.phase);
    const reversing = ["restoring", "restored"].includes(job.report.phase);
    if (
      !Number.isSafeInteger(job.configIndex) ||
      job.configIndex < 0 ||
      job.configIndex > count ||
      !Number.isSafeInteger(job.restoreConfigIndex) ||
      job.restoreConfigIndex < 0 ||
      job.restoreConfigIndex > job.configIndex ||
      (!reversing && job.restoreConfigIndex !== 0) ||
      (phase >= 4 && job.configIndex !== count) ||
      (phase >= 0 && phase < 3 && job.configIndex !== 0) ||
      (phase > 0 && !job.artifactsHash) ||
      (job.report.phase === "restored" && job.restoreConfigIndex !== job.configIndex) ||
      (job.report.status === "completed" && job.report.phase !== "completed") ||
      (job.report.status === "approved" && job.report.phase !== "approved")
    )
      throw new WorkspaceAliasError("state-diverged");
    if (
      job.intent &&
      !(
        (job.intent === "host" && phase === 1) ||
        (job.intent === "cli" && phase === 2) ||
        reversing
      )
    )
      throw new WorkspaceAliasError("state-diverged");
    if (
      reversing &&
      (!job.restoreInitial ||
        !["before", "after"].includes(job.restoreInitial.host) ||
        !["before", "after"].includes(job.restoreInitial.cli))
    )
      throw new WorkspaceAliasError("state-diverged");
    if (
      job.renameIntent &&
      (!Number.isSafeInteger(job.renameIntent.index) ||
        job.renameIntent.index < 0 ||
        job.renameIntent.index >= count ||
        (job.renameIntent.direction === "merge"
          ? reversing || job.renameIntent.index !== job.configIndex
          : !reversing ||
            job.renameIntent.direction !== "restore" ||
            job.renameIntent.index !== job.configIndex - job.restoreConfigIndex - 1))
    )
      throw new WorkspaceAliasError("state-diverged");
    if (
      job.journalIntent &&
      (!["merge", "restore"].includes(job.journalIntent.direction) ||
        !["host", "cli"].includes(job.journalIntent.kind) ||
        (job.journalIntent.direction === "merge" ? job.intent : job.restoreIntent) !==
          job.journalIntent.kind ||
        Object.values(job.journalIntent.image).some(
          (value) => typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value),
        ))
    )
      throw new WorkspaceAliasError("state-diverged");
    if (job.restoreIntent && (!reversing || !["host", "cli"].includes(job.restoreIntent)))
      throw new WorkspaceAliasError("state-diverged");
    return job;
  } catch {
    throw new WorkspaceAliasError("state-diverged");
  }
}

export async function readJob(locations: NodeLayout, jobId: string): Promise<AliasJob | null> {
  if (!workspaceAliasJobRequestSchema.shape.jobId.safeParse(jobId).success)
    throw new WorkspaceAliasError("boundary-rejected");
  return (
    (await withLedger(locations, false, (db) => {
      const row = db.prepare("SELECT data,revision FROM alias_job WHERE job_id=?").get(jobId);
      if (!row) return null;
      const job = validateJob(JSON.parse(String(row.data)) as AliasJob);
      workspaceAliasReportSchema.parse(job.report);
      if (job.report.jobId !== jobId || job.report.revision !== row.revision)
        throw new WorkspaceAliasError("state-diverged");
      return job;
    })) ?? null
  );
}
export async function listScopeJobs(
  locations: NodeLayout,
  sourceId: string,
  path: string,
): Promise<AliasJob[]> {
  return (
    (await withLedger(locations, false, (db) =>
      db
        .prepare("SELECT data FROM alias_job WHERE source_id=? AND path=? ORDER BY rowid DESC")
        .all(sourceId, path)
        .map((row) => validateJob(JSON.parse(String(row.data)) as AliasJob)),
    )) ?? []
  );
}
export async function saveJob(
  locations: NodeLayout,
  job: AliasJob,
  publish?: AliasImage | "restore",
): Promise<void> {
  await withLedger(locations, true, (db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const stored = db
        .prepare("SELECT revision FROM alias_job WHERE job_id=?")
        .get(job.report.jobId);
      if (stored && Number(stored.revision) !== job.report.revision)
        throw new WorkspaceAliasError("revision-stale");
      const previousRevision = job.report.revision;
      const revision = previousRevision + 1;
      db.prepare(
        "INSERT INTO alias_job VALUES(?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET revision=excluded.revision,data=excluded.data",
      ).run(
        job.report.jobId,
        revision,
        job.report.sourceServerId,
        job.plan.inspection.normalizedPath,
        JSON.stringify({ ...job, report: { ...job.report, revision } }),
      );
      if (publish === "restore") {
        const original = job.plan.inspection.aliases.find(
          (alias) =>
            alias.sourceServerId === job.report.sourceServerId &&
            alias.normalizedPath === job.plan.inspection.normalizedPath,
        );
        db.prepare("DELETE FROM workspace_alias WHERE source_id=? AND path=? AND job_id=?").run(
          job.report.sourceServerId,
          job.plan.inspection.normalizedPath,
          job.report.jobId,
        );
        if (original)
          db.prepare(
            "INSERT INTO workspace_alias VALUES(?,?,?,?) ON CONFLICT(source_id,path) DO UPDATE SET canonical_key=excluded.canonical_key,job_id=excluded.job_id",
          ).run(
            original.sourceServerId,
            original.normalizedPath,
            original.canonicalKey,
            original.jobId,
          );
      } else if (publish)
        db.prepare(
          "INSERT INTO workspace_alias VALUES(?,?,?,?) ON CONFLICT(source_id,path) DO UPDATE SET canonical_key=excluded.canonical_key,job_id=excluded.job_id",
        ).run(publish.sourceServerId, publish.normalizedPath, publish.canonicalKey, publish.jobId);
      db.exec("COMMIT");
      job.report.revision = revision;
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  });
}
