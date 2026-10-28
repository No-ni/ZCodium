import { lstat } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { ZCODE_USER_DATA_DIR_NAME } from "@zcode/shared";
import { workspaceAliasScopeSchema, type WorkspaceAliasScope } from "../contract.js";
import type {
  ISourceWorkspaceInspectionService,
  SourceWorkspaceInspectionResult,
} from "../inspection-contract.js";
import { stableWorkspaceIdentity } from "../domain/identity.js";
import { assertRoot, assertSafePath, hash, insidePath, rootIdentity } from "./files.js";

export interface NodeSourceWorkspaceInspectionOptions {
  sourceServerId: string;
  dataRoot: string;
  taskDatabasePath: string;
  sessionDatabasePath: string;
  configHashRoots?: readonly string[];
  afterObservation?(): void | Promise<void>;
}

function inspectionPaths(options: NodeSourceWorkspaceInspectionOptions): string[] {
  if (!isAbsolute(options.dataRoot) || basename(options.dataRoot) !== ZCODE_USER_DATA_DIR_NAME)
    throw new Error("Unknown Source history root");
  const root = resolve(options.dataRoot);
  const databases = [options.taskDatabasePath, options.sessionDatabasePath];
  const configurations = options.configHashRoots ?? [join(root, "v2", "sessions")];
  const paths = [
    ...databases.flatMap((path) => [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]),
    ...configurations,
    ...["source-workspace-owner.sqlite", "source-workspace-alias.sqlite"].flatMap((name) =>
      ["", "-wal", "-shm", "-journal"].map((suffix) => join(root, "v2", `${name}${suffix}`)),
    ),
    join(root, "v2", "workspace-alias-jobs"),
  ];
  for (const path of paths) {
    if (!isAbsolute(path) || resolve(path) === root || !insidePath(root, resolve(path)))
      throw new Error("Incomplete Source history scope");
  }
  return [...new Set(paths.map((path) => resolve(path)))];
}

async function observe(root: string, paths: readonly string[]) {
  const generation = await rootIdentity(root);
  const observations = [];
  for (const path of paths) {
    const exists = await assertSafePath(root, path, true);
    if (!exists) {
      observations.push({ path, exists: false });
      continue;
    }
    const info = await lstat(path, { bigint: true });
    observations.push({
      path,
      exists: true,
      generation: hash({
        dev: String(info.dev),
        ino: String(info.ino),
        birth: String(info.birthtimeNs),
        size: String(info.size),
        mtime: String(info.mtimeNs),
        ctime: String(info.ctimeNs),
        kind: info.isDirectory() ? "directory" : "file",
      }),
    });
  }
  if (generation !== (await rootIdentity(root))) throw new Error("Source history root changed");
  return { generation, observations };
}

export function createNodeSourceWorkspaceInspectionService(
  options: NodeSourceWorkspaceInspectionOptions,
): ISourceWorkspaceInspectionService {
  const frozen = {
    ...options,
    ...(options.configHashRoots ? { configHashRoots: [...options.configHashRoots] } : {}),
  };
  return {
    async getCapabilities() {
      return { version: 1 };
    },
    async inspect(input: WorkspaceAliasScope): Promise<SourceWorkspaceInspectionResult> {
      const scope = workspaceAliasScopeSchema.parse(input);
      if (scope.sourceServerId !== frozen.sourceServerId)
        throw new Error("Source workspace inspection identity is unavailable");
      const stableIdentity = stableWorkspaceIdentity(scope.sourceServerId, scope.workspacePath);
      const base = { ...scope, schemaVersion: 1 as const, stableIdentity };
      try {
        const paths = inspectionPaths(frozen);
        await assertRoot(frozen.dataRoot);
        const before = await observe(frozen.dataRoot, paths);
        await frozen.afterObservation?.();
        const after = await observe(frozen.dataRoot, paths);
        if (hash(before) !== hash(after))
          return { ...base, state: "unavailable", reason: "source-workspace-inspection-stale" };
        // 存在性不能证明旧 key 归属或 WAL 零写快照；只阻断，不读取业务 getter 或启动迁移。
        if (before.observations.some((entry) => entry.exists))
          return { ...base, state: "history-present", reason: "source-workspace-history-present" };
        return { ...base, state: "clear" };
      } catch {
        return { ...base, state: "unavailable", reason: "source-workspace-inspection-unavailable" };
      }
    },
  };
}
