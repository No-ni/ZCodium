import type {
  WorkspaceAliasAuthority,
  WorkspaceAliasReport,
  WorkspaceAliasScope,
} from "../contract.js";
import { WorkspaceAliasError, workspaceAliasAuthoritySnapshotSchema } from "../contract.js";
import type {
  DatabaseImage,
  DatabaseJournalImage,
  MergeOutput,
  MergePlan,
  WorkspaceInspection,
} from "../domain/images.js";
import { field, table } from "../domain/images.js";
import {
  matchingWorkspacePath,
  normalizedWorkspacePath,
  stableWorkspaceIdentity,
  verifiedKeys,
} from "../domain/identity.js";
import { rootIdentity, assertSafePath, workspaceDirectoryHash } from "./files.js";
import { readDatabase } from "./database.js";
import { readConfig } from "./configs.js";
import { assertPublishedLedger } from "./published-ledger.js";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { ZCODE_USER_DATA_DIR_NAME } from "@zcode/shared";

export interface NodeWorkspaceAliasOptions {
  dataRoot: string;
  taskDatabasePath?: string;
  sessionDatabasePath?: string;
  /** 显式候选hash根，默认v2/sessions；不得指向.zcode或其它Source数据根。 */
  configHashRoots?: readonly string[];
  authority: WorkspaceAliasAuthority;
  now?: () => number;
  approvalTtlMs?: number;
  afterPhaseCommitted?: (
    phase:
      | WorkspaceAliasReport["phase"]
      | "host-intent"
      | "cli-intent"
      | "host-committed"
      | "cli-committed"
      | "restore-host-intent"
      | "restore-cli-intent"
      | "restore-host-committed"
      | "restore-cli-committed"
      | "config-renamed"
      | "config-rename"
      | "config-rename-intent"
      | "host-backup-created"
      | "cli-backup-created"
      | "config-backup-created"
      | "backups-published",
    jobId: string,
  ) => void | Promise<void>;
  beforeBackup?: (jobId: string) => void | Promise<void>;
}
export interface AliasJob {
  report: WorkspaceAliasReport;
  plan: MergePlan;
  output: MergeOutput;
  choices: Array<{ collisionId: string; sourceKey: string }>;
  intent?: "host" | "cli";
  journalIntent?: {
    kind: "host" | "cli";
    direction: "merge" | "restore";
    image: DatabaseJournalImage;
  };
  restoreStep?: "configs" | "cli" | "host";
  restoreIntent?: "host" | "cli";
  restoreInitial?: Record<"host" | "cli", "before" | "after">;
  restoreCommitted?: Array<"host" | "cli">;
  renameIntent?: { direction: "merge" | "restore"; index: number };
  configIndex: number;
  restoreConfigIndex: number;
  artifactsHash?: string;
}
export interface NodeLayout {
  root: string;
  host: string;
  cli: string;
  configRoots: string[];
  owner: string;
  ledger: string;
  jobs: string;
}
export function layout(options: NodeWorkspaceAliasOptions): NodeLayout {
  if (!isAbsolute(options.dataRoot) || basename(options.dataRoot) !== ZCODE_USER_DATA_DIR_NAME)
    throw new WorkspaceAliasError("boundary-rejected");
  const root = resolve(options.dataRoot);
  const locations = {
    root,
    host: options.taskDatabasePath ?? join(root, "v2", "tasks-index.sqlite"),
    cli: options.sessionDatabasePath ?? join(root, "cli", "db", "db.sqlite"),
    configRoots: [...(options.configHashRoots ?? [join(root, "v2", "sessions")])],
    owner: join(root, "v2", "source-workspace-owner.sqlite"),
    ledger: join(root, "v2", "source-workspace-alias.sqlite"),
    jobs: join(root, "v2", "workspace-alias-jobs"),
  };
  const inside = (parent: string, path: string): boolean => {
    const distance = relative(parent, path);
    return (
      distance === "" ||
      (!isAbsolute(distance) &&
        distance !== ".." &&
        !distance.startsWith("..\\") &&
        !distance.startsWith("../"))
    );
  };
  const paths = [
    locations.host,
    locations.cli,
    locations.owner,
    locations.ledger,
    locations.jobs,
    ...locations.configRoots,
  ];
  // 数据库、备份和候选根不能互为祖先；Windows使用path.relative而不是硬编码斜杠前缀。
  for (const [index, path] of paths.entries()) {
    if (
      !isAbsolute(path) ||
      resolve(path) === root ||
      !inside(root, path) ||
      relative(root, path)
        .split(/[\\/]/)
        .some((part) => [".zcode", ".zcodium"].includes(part.toLowerCase()))
    )
      throw new WorkspaceAliasError("boundary-rejected");
    if (paths.slice(0, index).some((other) => inside(other, path) || inside(path, other)))
      throw new WorkspaceAliasError("boundary-rejected");
  }
  return {
    ...locations,
    host: resolve(locations.host),
    cli: resolve(locations.cli),
    configRoots: locations.configRoots.map((path) => resolve(path)),
  };
}
function requireReady(image: DatabaseImage, kind: "host" | "cli"): void {
  if (!image.exists) return;
  assertPublishedLedger(image, kind);
  const journal = table(image, kind === "host" ? "tasks_schema_migration" : "schema_migration");
  if (!journal || journal.rows.length !== (kind === "host" ? 3 : 23))
    throw new WorkspaceAliasError("schema-incompatible");
  const columns: Readonly<Record<string, readonly string[]>> =
    kind === "host"
      ? {
          tasks: ["workspace_key", "workspace_path", "workspace_identity", "task_id", "meta_json"],
          task_groups: ["group_id"],
          task_group_members: ["workspace_key", "task_id", "group_id"],
          task_group_view_node_orders: ["node_type", "node_key"],
          task_group_workspace_bootstraps: ["workspace_key", "group_id"],
          automations: ["workspace_key", "workspace_path", "automation_id"],
          automation_runs: ["workspace_key", "automation_id"],
          off_peak_tasks: ["workspace_key", "workspace_path", "off_peak_task_id"],
        }
      : {
          session: ["id", "project_id", "workspace_id", "directory", "path"],
          message: ["session_id"],
          part: ["session_id", "message_id"],
          session_input: ["session_id", "status"],
        };
  for (const [name, required] of Object.entries(columns))
    if (required.some((column) => !table(image, name)?.columns.includes(column)))
      throw new WorkspaceAliasError("schema-incompatible");
  for (const row of journal.rows)
    if (
      typeof field(row, journal, "checksum") !== "string" ||
      !/^[a-f0-9]{64}$/.test(String(field(row, journal, "checksum")))
    )
      throw new WorkspaceAliasError("schema-incompatible");
}
export async function inspectWorkspace(
  options: NodeWorkspaceAliasOptions,
  scope: WorkspaceAliasScope,
  aliases: WorkspaceInspection["aliases"],
  signal?: AbortSignal,
): Promise<WorkspaceInspection> {
  const locations = layout(options);
  const rootGeneration = await rootIdentity(locations.root);
  for (const path of [locations.host, locations.cli, ...locations.configRoots])
    await assertSafePath(locations.root, path, true);
  const validation = workspaceAliasAuthoritySnapshotSchema.safeParse(
    await options.authority.inspect(scope, signal),
  );
  if (!validation.success) throw new WorkspaceAliasError("source-stale");
  const verified = validation.data;
  if (verified.sourceServerId !== scope.sourceServerId)
    throw new WorkspaceAliasError("source-stale");
  const allowedKeys = verifiedKeys(
    scope.sourceServerId,
    scope.workspacePath,
    verified.legacyWorkspaceKeys,
  );
  const existing = aliases.find(
    (value) =>
      value.sourceServerId === scope.sourceServerId &&
      value.normalizedPath === normalizedWorkspacePath(scope.workspacePath),
  );
  if (existing && !allowedKeys.includes(existing.canonicalKey))
    throw new WorkspaceAliasError("source-stale");
  const host = await readDatabase(locations.root, locations.host, signal);
  const cli = await readDatabase(locations.root, locations.cli, signal);
  requireReady(host, "host");
  requireReady(cli, "cli");
  const hashNames = allowedKeys.map(workspaceDirectoryHash);
  if (new Set(hashNames).size !== hashNames.length)
    throw new WorkspaceAliasError("boundary-rejected");
  const configs = [];
  for (const root of locations.configRoots)
    for (const key of allowedKeys)
      configs.push(
        await readConfig(
          locations.root,
          { root, workspaceKey: key, directory: join(root, workspaceDirectoryHash(key)) },
          signal,
        ),
      );
  for (const layout of host.tables)
    for (const row of layout.rows) {
      const key = field(row, layout, "workspace_key");
      if (typeof key !== "string" || !allowedKeys.includes(key)) continue;
      const identity = field(row, layout, "workspace_identity");
      const path = field(row, layout, "workspace_path");
      if (
        (identity != null && identity !== key) ||
        (path != null &&
          (typeof path !== "string" ||
            !matchingWorkspacePath(path, scope.workspacePath, allowedKeys)))
      )
        throw new WorkspaceAliasError("state-diverged");
      if (layout.name === "tasks") {
        let meta: unknown;
        try {
          meta = JSON.parse(String(field(row, layout, "meta_json")));
        } catch {
          throw new WorkspaceAliasError("state-diverged");
        }
        if (!meta || typeof meta !== "object" || Array.isArray(meta))
          throw new WorkspaceAliasError("state-diverged");
        const record = meta as Record<string, unknown>;
        if (
          (record.workspaceIdentity != null && record.workspaceIdentity !== key) ||
          (record.workspacePath != null &&
            (typeof record.workspacePath !== "string" ||
              !matchingWorkspacePath(record.workspacePath, scope.workspacePath, allowedKeys)))
        )
          throw new WorkspaceAliasError("state-diverged");
      }
    }
  const sessions = table(cli, "session");
  for (const row of sessions?.rows ?? []) {
    const key = field(row, sessions!, "workspace_id");
    if (typeof key !== "string" || !allowedKeys.includes(key)) continue;
    const directory = field(row, sessions!, "directory");
    const path = field(row, sessions!, "path");
    // directory/path一个正确不能掩盖另一个明确冲突；没有值的path不参与归属证明。
    if (
      typeof directory !== "string" ||
      !matchingWorkspacePath(directory, scope.workspacePath, allowedKeys) ||
      (path != null &&
        (typeof path !== "string" ||
          !matchingWorkspacePath(path, scope.workspacePath, allowedKeys)))
    )
      throw new WorkspaceAliasError("state-diverged");
  }
  if ((await rootIdentity(locations.root)) !== rootGeneration)
    throw new WorkspaceAliasError("state-diverged");
  return {
    scope,
    rootGeneration,
    normalizedPath: normalizedWorkspacePath(scope.workspacePath),
    stableIdentity: stableWorkspaceIdentity(scope.sourceServerId, scope.workspacePath),
    generation: verified.generation,
    projectId: verified.projectId,
    allowedKeys,
    host,
    cli,
    configs,
    aliases,
  };
}
