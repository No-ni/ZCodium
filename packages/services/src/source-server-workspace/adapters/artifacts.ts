import { randomUUID } from "node:crypto";
import { rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { WorkspaceAliasError } from "../contract.js";
import type { ConfigImage } from "../domain/images.js";
import type { AliasJob, NodeLayout, NodeWorkspaceAliasOptions } from "./inspection.js";
import { createBackup, databaseDigest, readDatabase } from "./database.js";
import {
  configDigest,
  configOperations as buildConfigOperations,
  materialize,
  readConfig,
  runRename,
  type ConfigRename,
} from "./configs.js";
import {
  assertSafePath,
  bytesHash,
  hash,
  makeDirectory,
  readSafe,
  syncDirectory,
  writeAtomic,
} from "./files.js";
import { saveJob } from "./ledger.js";

export interface JobArtifacts {
  version: 1;
  jobId: string;
  hostHash?: string;
  cliHash?: string;
  hostFileHash?: string;
  cliFileHash?: string;
  configHashes: string[];
  operations: ConfigRename[];
}
export function artifactRoot(locations: NodeLayout, job: AliasJob): string {
  return join(locations.jobs, job.report.jobId);
}
export function configOperations(locations: NodeLayout, job: AliasJob): ConfigRename[] {
  return buildConfigOperations(
    artifactRoot(locations, job),
    job.plan.inspection.configs,
    job.output.configs,
  );
}
async function artifactConfig(
  root: string,
  target: string,
  expected: ConfigImage,
  signal?: AbortSignal,
): Promise<void> {
  const copy = await readConfig(root, { ...expected, directory: target }, signal);
  // 不存在的原目录也有独立空备份容器，缺失容器不能冒充原本不存在。
  if (
    !copy.exists ||
    (!expected.exists && copy.entries.length) ||
    configDigest({ ...copy, directory: expected.directory, exists: expected.exists }) !==
      configDigest(expected)
  )
    throw new WorkspaceAliasError("backup-failed");
}
async function publish(
  root: string,
  from: string,
  to: string,
  assertCurrent: () => Promise<void>,
): Promise<void> {
  await makeDirectory(root, dirname(to));
  if (await assertSafePath(root, to, true)) throw new WorkspaceAliasError("backup-failed");
  await assertSafePath(root, from);
  await assertCurrent();
  await rename(from, to);
  await syncDirectory(dirname(to));
}
export async function createArtifacts(
  locations: NodeLayout,
  job: AliasJob,
  options: NodeWorkspaceAliasOptions,
  assertCurrent: () => Promise<void>,
  signal?: AbortSignal,
): Promise<JobArtifacts> {
  const root = artifactRoot(locations, job);
  const metadataPath = join(root, "backup.json");
  if (await assertSafePath(locations.root, metadataPath, true)) {
    const artifacts = await validateArtifacts(locations, job, signal);
    if (!job.artifactsHash) {
      job.artifactsHash = hash(artifacts);
      await saveJob(locations, job);
    }
    return artifacts;
  }
  await options.beforeBackup?.(job.report.jobId);
  signal?.throwIfAborted();
  const scratch = join(root, `scratch-${randomUUID()}`);
  await makeDirectory(locations.root, scratch);
  const artifacts: JobArtifacts = {
    version: 1,
    jobId: job.report.jobId,
    configHashes: [],
    operations: configOperations(locations, job),
  };
  try {
    for (const kind of ["host", "cli"] as const) {
      const image = job.plan.inspection[kind];
      if (!image.exists) continue;
      const target = join(root, `${kind}.sqlite`);
      if (!(await assertSafePath(locations.root, target, true))) {
        const temporary = join(scratch, `${kind}.sqlite`);
        await assertCurrent();
        await createBackup(locations.root, locations[kind], temporary, image, signal);
        await options.afterPhaseCommitted?.(`${kind}-backup-created`, job.report.jobId);
        await publish(locations.root, temporary, target, assertCurrent);
      }
      const copy = await readDatabase(locations.root, target, signal);
      copy.identity = image.identity;
      if (databaseDigest(copy) !== databaseDigest(image))
        throw new WorkspaceAliasError("backup-failed");
      artifacts[`${kind}Hash`] = databaseDigest(copy);
      artifacts[`${kind}FileHash`] = bytesHash(await readSafe(locations.root, target, signal));
    }
    for (let index = 0; index < job.plan.inspection.configs.length; index++) {
      const image = job.plan.inspection.configs[index]!;
      const target = join(root, "config-backup", String(index));
      if (!(await assertSafePath(locations.root, target, true))) {
        const temporary = join(scratch, "config-backup", String(index));
        await materialize(locations.root, temporary, image, signal);
        await artifactConfig(locations.root, temporary, image, signal);
        await options.afterPhaseCommitted?.("config-backup-created", job.report.jobId);
        await publish(locations.root, temporary, target, assertCurrent);
      }
      await artifactConfig(locations.root, target, image, signal);
      artifacts.configHashes.push(configDigest(image));
      const after = job.output.configs[index]!;
      if (after.exists && configDigest(image) !== configDigest(after)) {
        const prepared = join(root, "prepared", String(index));
        if (!(await assertSafePath(locations.root, prepared, true))) {
          const temporary = join(scratch, "prepared", String(index));
          await materialize(locations.root, temporary, after, signal);
          await publish(locations.root, temporary, prepared, assertCurrent);
        }
        await artifactConfig(locations.root, prepared, after, signal);
      }
    }
    await assertCurrent();
    signal?.throwIfAborted();
    await writeAtomic(locations.root, metadataPath, JSON.stringify(artifacts));
    await options.afterPhaseCommitted?.("backups-published", job.report.jobId);
    job.artifactsHash = hash(artifacts);
    await saveJob(locations, job);
    return await validateArtifacts(locations, job, signal);
  } finally {
    // 只清本次明确创建的scratch；崩溃留下的旧scratch不扫描、不导入、不覆盖已发布备份。
    await assertSafePath(locations.root, scratch, true);
    await rm(scratch, { recursive: true, force: true });
  }
}
export async function validateArtifacts(
  locations: NodeLayout,
  job: AliasJob,
  signal?: AbortSignal,
): Promise<JobArtifacts> {
  const root = artifactRoot(locations, job);
  try {
    const artifacts = JSON.parse(
      (await readSafe(locations.root, join(root, "backup.json"), signal)).toString("utf8"),
    ) as JobArtifacts;
    if (
      artifacts.version !== 1 ||
      artifacts.jobId !== job.report.jobId ||
      (job.artifactsHash && hash(artifacts) !== job.artifactsHash) ||
      hash(artifacts.operations) !== hash(configOperations(locations, job)) ||
      artifacts.configHashes.length !== job.plan.inspection.configs.length
    )
      throw new WorkspaceAliasError("backup-failed");
    for (const kind of ["host", "cli"] as const) {
      const expected = job.plan.inspection[kind];
      if (!expected.exists) {
        if (artifacts[`${kind}Hash`] || artifacts[`${kind}FileHash`])
          throw new WorkspaceAliasError("backup-failed");
        continue;
      }
      const path = join(root, `${kind}.sqlite`);
      const copy = await readDatabase(locations.root, path, signal);
      copy.identity = expected.identity;
      if (
        databaseDigest(copy) !== databaseDigest(expected) ||
        databaseDigest(copy) !== artifacts[`${kind}Hash`] ||
        bytesHash(await readSafe(locations.root, path, signal)) !== artifacts[`${kind}FileHash`]
      )
        throw new WorkspaceAliasError("backup-failed");
    }
    for (let index = 0; index < job.plan.inspection.configs.length; index++) {
      const image = job.plan.inspection.configs[index]!;
      await artifactConfig(
        locations.root,
        join(root, "config-backup", String(index)),
        image,
        signal,
      );
      if (artifacts.configHashes[index] !== configDigest(image))
        throw new WorkspaceAliasError("backup-failed");
    }
    return artifacts;
  } catch (error) {
    if (
      error instanceof WorkspaceAliasError ||
      signal?.aborted ||
      ["EACCES", "EPERM", "ENOSPC", "EDQUOT"].includes((error as NodeJS.ErrnoException).code ?? "")
    )
      throw error;
    throw new WorkspaceAliasError("backup-failed");
  }
}
export async function expectedConfigState(
  locations: NodeLayout,
  job: AliasJob,
  index: number,
  operations: readonly ConfigRename[],
  signal?: AbortSignal,
): Promise<void> {
  const expected = new Map<string, ConfigImage>();
  const absent = (image: ConfigImage, directory: string): ConfigImage => ({
    ...image,
    directory,
    exists: false,
    entries: [],
  });
  for (const image of job.plan.inspection.configs) expected.set(image.directory, image);
  for (const operation of operations) {
    if (!expected.has(operation.to))
      expected.set(operation.to, absent(operation.image, operation.to));
    if (!expected.has(operation.from))
      expected.set(operation.from, { ...operation.image, directory: operation.from });
  }
  for (const operation of operations.slice(0, index)) {
    expected.set(operation.from, absent(operation.image, operation.from));
    expected.set(operation.to, { ...operation.image, directory: operation.to });
  }
  for (const [path, image] of expected) {
    const actual = await readConfig(locations.root, { ...image, directory: path }, signal);
    if (configDigest(actual) !== configDigest(image))
      throw new WorkspaceAliasError("state-diverged");
  }
}
export async function verifiedConfigIndex(
  locations: NodeLayout,
  job: AliasJob,
  operations: readonly ConfigRename[],
  restoring: boolean,
  signal?: AbortSignal,
): Promise<number> {
  const index = restoring ? job.configIndex - job.restoreConfigIndex : job.configIndex;
  try {
    await expectedConfigState(locations, job, index, operations, signal);
    return index;
  } catch (error) {
    const next = restoring ? index - 1 : index + 1;
    // 仅durable方向/索引intent允许认领rename与索引之间窗口，不能猜测外部已移动同内容目录。
    if (
      !(error instanceof WorkspaceAliasError) ||
      error.code !== "state-diverged" ||
      job.renameIntent?.direction !== (restoring ? "restore" : "merge") ||
      job.renameIntent.index !== (restoring ? next : index) ||
      next < 0 ||
      next > operations.length
    )
      throw error;
    await expectedConfigState(locations, job, next, operations, signal);
    return next;
  }
}
export async function mergeConfigs(
  locations: NodeLayout,
  job: AliasJob,
  artifacts: JobArtifacts,
  options: NodeWorkspaceAliasOptions,
  assertCurrent: () => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const operations = artifacts.operations;
  while (job.configIndex < operations.length) {
    await assertCurrent();
    if (
      job.renameIntent &&
      (job.renameIntent.direction !== "merge" || job.renameIntent.index !== job.configIndex)
    )
      throw new WorkspaceAliasError("state-diverged");
    job.renameIntent = { direction: "merge", index: job.configIndex };
    await saveJob(locations, job);
    await options.afterPhaseCommitted?.("config-rename-intent", job.report.jobId);
    await runRename(locations.root, operations[job.configIndex]!, signal, assertCurrent);
    await expectedConfigState(locations, job, job.configIndex + 1, operations, signal);
    await options.afterPhaseCommitted?.("config-renamed", job.report.jobId);
    job.configIndex++;
    delete job.renameIntent;
    await saveJob(locations, job);
    await options.afterPhaseCommitted?.("config-rename", job.report.jobId);
    signal?.throwIfAborted();
  }
  await expectedConfigState(locations, job, operations.length, operations, signal);
}
