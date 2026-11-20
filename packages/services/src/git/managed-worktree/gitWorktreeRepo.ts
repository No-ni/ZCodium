import { readWorktreeStartRefs } from "./worktreeStartRefs.js";
import { createWorktreeFileOperations } from "./worktreeFiles.js";
import { randomBytes } from "node:crypto";
import { mkdir, realpath, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import type {
  CreateManagedWorktreeRequest,
  CreateManagedWorktreeResult,
  ListManagedWorktreesRequest,
  ListManagedWorktreesResult,
  ManagedWorktreeInfo,
  PruneWorktreesRequest,
  RemoveManagedWorktreeRequest,
  RemoveManagedWorktreeResult,
} from "@zcode/shared";
import {
  MANAGED_WORKTREE_SPOTLIGHT_MARKER,
  isSamePath,
  managedWorktreeDirectoryName,
  parseManagedWorktreePath,
  resolveManagedWorktreeRoot,
} from "@zcode/shared/managed-worktree";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import {
  DEFAULT_GIT_COMMAND_TIMEOUT_MS,
  DEFAULT_GIT_OUTPUT_BYTES,
  normalizeGitPath,
} from "../config.js";
import type { GitCommandProvider } from "../providers/gitCommandProvider.js";
import type { GitWorktreeCreateOptions, GitWorktreeRepo } from "./contract.js";
import { WORKTREE_INCLUDE_FILE } from "./worktreeFiles.js";
import {
  type SourceRepository,
  type PorcelainWorktree,
  failure,
  stderrDetail,
  pathExists,
  realpathOr,
  parseWorktreeListPorcelain,
} from "./worktreeTopology.js";
export { parseWorktreeListPorcelain } from "./worktreeTopology.js";

export { WORKTREE_INCLUDE_FILE } from "./worktreeFiles.js";

const log = createServiceLogger("git-worktree");

/** `git worktree add` 是一次完整 checkout，大仓库可能需要几十秒；普通 15s 超时会误判失败。 */
const WORKTREE_ADD_TIMEOUT_MS = 10 * 60_000;

/** `git worktree remove` 需要删除整棵目录树（含被忽略的依赖目录）。 */
const WORKTREE_REMOVE_TIMEOUT_MS = 5 * 60_000;

/** bucket 冲突时的最大重试次数；4 位 hex 共 65536 个，正常远小于这个次数就能命中空位。 */
const MAX_BUCKET_ATTEMPTS = 64;

const BUCKET_BYTES = 2;

const GIT_DIRNAME = ".git";

const HEAD_REF = "HEAD";

export function createGitWorktreeRepo(options: {
  commandProvider: GitCommandProvider;
  /** 数据根目录（与 CLI 一致：ZCODE_DATA_BASE_DIR 优先，否则 homedir）。 */
  dataBaseDir: () => string;
  platform?: NodeJS.Platform;
}): GitWorktreeRepo {
  const { commandProvider } = options;
  const platform = options.platform ?? process.platform;

  function run(
    cwd: string,
    args: string[],
    timeoutMs = DEFAULT_GIT_COMMAND_TIMEOUT_MS,
    extra: { maxOutputBytes?: number; onOutput?: (text: string) => void } = {},
  ) {
    return commandProvider.run({
      cwd,
      args,
      timeoutMs,
      maxOutputBytes: extra.maxOutputBytes ?? DEFAULT_GIT_OUTPUT_BYTES,
      ...(extra.onOutput ? { onOutput: ({ text }) => extra.onOutput?.(text) } : {}),
    });
  }
  const { copyIncludedFiles, readCarriedChanges, applyCarriedChanges } =
    createWorktreeFileOperations(run);

  /** 回滚本次创建：登记过的 worktree 强制移除，再删 bucket 并 prune 半成品登记。 */
  async function rollback(sourceRoot: string, bucketDir: string, worktreeRoot: string) {
    await run(
      sourceRoot,
      ["worktree", "remove", "--force", worktreeRoot],
      WORKTREE_REMOVE_TIMEOUT_MS,
    );
    await rm(bucketDir, { recursive: true, force: true });
    await run(sourceRoot, ["worktree", "prune"]);
  }

  function managedRoot(): string {
    return resolveManagedWorktreeRoot(options.dataBaseDir());
  }

  async function resolveSourceRepository(sourcePath: string): Promise<SourceRepository | null> {
    const realSource = await realpathOr(sourcePath);
    const result = await run(realSource, [
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--git-common-dir",
    ]);
    if (result.exitCode !== 0) return null;
    const [toplevel, commonDir] = result.stdout.split(/\r?\n/).filter(Boolean);
    if (!toplevel || !commonDir) return null;
    const checkoutRoot = await realpathOr(toplevel);
    const realCommon = await realpathOr(commonDir);
    // 只支持普通仓库（common dir = <toplevel>/.git）；bare 仓库没有可作为源的工作区。
    if (basename(realCommon) !== GIT_DIRNAME) return null;
    return {
      checkoutRoot,
      sourceRoot: dirname(realCommon),
      relativeCwd: relative(checkoutRoot, realSource),
    };
  }

  async function listPorcelain(sourceRoot: string): Promise<PorcelainWorktree[] | null> {
    const result = await run(sourceRoot, ["worktree", "list", "--porcelain", "-z"]);
    if (result.exitCode !== 0) return null;
    return parseWorktreeListPorcelain(result.stdout);
  }

  async function toManagedInfo(
    record: PorcelainWorktree,
    sourceRoot: string,
    realManagedRoot: string,
  ): Promise<ManagedWorktreeInfo | null> {
    if (record.bare) return null;
    const exists = !record.prunable && (await pathExists(record.path));
    const candidate = exists ? await realpathOr(record.path) : record.path;
    const parts = parseManagedWorktreePath(realManagedRoot, candidate);
    // 只认 <root>/<bucket>/<name> 根本身；用户自建 worktree 或更深的路径都不是受管条目。
    if (!parts || parts.relativePath !== "") return null;
    if (exists) {
      const dotGit = await stat(join(candidate, GIT_DIRNAME)).catch(() => null);
      if (!dotGit?.isFile()) return null;
    }
    return {
      path: candidate,
      bucket: parts.bucket,
      sourceRoot,
      head: exists ? record.head : null,
      branchName: exists ? record.branchName : null,
      state: exists ? "ok" : "missing",
      dirty: exists ? await isDirty(candidate) : null,
    };
  }

  /** 与删除预检同一判定：有修改或未跟踪文件即为 dirty；读取失败按 null（未知）处理。 */
  async function isDirty(worktreeRoot: string): Promise<boolean | null> {
    const status = await run(worktreeRoot, [
      "status",
      "--porcelain",
      "-z",
      "--untracked-files=normal",
    ]);
    return status.exitCode === 0 ? status.stdout.length > 0 : null;
  }

  async function list(request: ListManagedWorktreesRequest): Promise<ListManagedWorktreesResult> {
    const source = await resolveSourceRepository(request.sourcePath);
    if (!source) return { sourceRoot: null, worktrees: [] };
    const root = managedRoot();
    if (!(await pathExists(root))) return { sourceRoot: source.sourceRoot, worktrees: [] };
    const realManagedRoot = await realpathOr(root);
    const records = (await listPorcelain(source.sourceRoot)) ?? [];
    const worktrees: ManagedWorktreeInfo[] = [];
    for (const record of records) {
      const info = await toManagedInfo(record, source.sourceRoot, realManagedRoot);
      if (info) worktrees.push(info);
    }
    return { sourceRoot: source.sourceRoot, worktrees };
  }

  async function ensureManagedRoot(): Promise<string> {
    const root = managedRoot();
    await mkdir(root, { recursive: true });
    if (platform === "darwin") {
      const marker = join(root, MANAGED_WORKTREE_SPOTLIGHT_MARKER);
      if (!(await pathExists(marker))) await writeFile(marker, "");
    }
    return await realpath(root);
  }

  /** 非递归 mkdir 原子占用 bucket；EEXIST 时重新随机，保证并发创建得到不同目录。 */
  async function allocateBucket(realManagedRoot: string): Promise<string | null> {
    for (let attempt = 0; attempt < MAX_BUCKET_ATTEMPTS; attempt += 1) {
      const bucketDir = join(realManagedRoot, randomBytes(BUCKET_BYTES).toString("hex"));
      try {
        await mkdir(bucketDir);
        return bucketDir;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    return null;
  }

  async function create(
    request: CreateManagedWorktreeRequest,
    createOptions: GitWorktreeCreateOptions = {},
  ): Promise<CreateManagedWorktreeResult> {
    const emit = (text: string) => createOptions.onOutput?.(text);
    emit("[info] Starting worktree creation\n");
    const source = await resolveSourceRepository(request.sourcePath);
    if (!source) return failure("not-repository");

    if (request.carryChanges && request.startRef?.trim()) return failure("invalid-start-ref");
    const startRef = request.startRef?.trim() || HEAD_REF;
    const resolved = await run(source.checkoutRoot, [
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${startRef}^{commit}`,
    ]);
    const commit = resolved.stdout.trim();
    if (resolved.exitCode !== 0 || !commit) return failure("invalid-start-ref", startRef);

    if (source.relativeCwd) {
      // 项目主目录是仓库子目录时，起点 commit 中必须存在该子目录，否则任务 cwd 无从建立。
      const treePath = `${commit}:${normalizeGitPath(source.relativeCwd.split(sep).join("/"))}`;
      const kind = await run(source.checkoutRoot, ["cat-file", "-t", treePath]);
      if (kind.exitCode !== 0 || kind.stdout.trim() !== "tree") {
        return failure("start-ref-missing-subdir", source.relativeCwd);
      }
    }

    // 带入改动的快照在检出前读取：之后父任务的改动不带入（§3.6）。
    let carried: Awaited<ReturnType<typeof readCarriedChanges>> | null = null;
    if (request.carryChanges) {
      try {
        carried = await readCarriedChanges(source.checkoutRoot, commit);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        emit(`[error] Failed to read uncommitted changes: ${detail}\n`);
        return failure("carry-failed", detail);
      }
    }

    const realManagedRoot = await ensureManagedRoot();
    const bucketDir = await allocateBucket(realManagedRoot);
    if (!bucketDir) return failure("bucket-exhausted");
    const worktreeRoot = join(bucketDir, managedWorktreeDirectoryName(source.sourceRoot));
    createOptions.onPathAllocated?.(worktreeRoot);

    const added = await run(
      source.checkoutRoot,
      ["worktree", "add", "--detach", worktreeRoot, commit],
      WORKTREE_ADD_TIMEOUT_MS,
      { onOutput: emit },
    );
    if (added.exitCode !== 0 || added.timedOut) {
      // 回滚只针对本次占用的 bucket；随后 prune 清掉 git 里可能残留的半成品登记。
      await rm(bucketDir, { recursive: true, force: true });
      await run(source.sourceRoot, ["worktree", "prune"]);
      log.warn(
        undefined,
        `worktree add failed source=${source.sourceRoot} bucket=${basename(bucketDir)}`,
      );
      return failure("git-failed", stderrDetail(added));
    }

    const realWorktreeRoot = await realpath(worktreeRoot);
    emit(`Worktree created at ${realWorktreeRoot}\n`);
    if (carried) {
      try {
        await applyCarriedChanges(source.checkoutRoot, bucketDir, realWorktreeRoot, carried);
        emit(
          `Carried ${carried.count} changed file${carried.count === 1 ? "" : "s"} from ${source.checkoutRoot}\n`,
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        emit(`[error] Failed to carry uncommitted changes: ${detail}\n`);
        await rollback(source.sourceRoot, bucketDir, realWorktreeRoot);
        return failure("carry-failed", detail);
      }
    }
    try {
      // 拷贝来源始终是源仓库主 checkout（fork 时父任务可能在另一个 worktree 中）。
      const copied = await copyIncludedFiles(source.sourceRoot, realWorktreeRoot);
      if (copied > 0)
        emit(`Copied ${copied} file${copied === 1 ? "" : "s"} from ${WORKTREE_INCLUDE_FILE}\n`);
    } catch (error) {
      // 任一文件拷贝失败即整个创建失败：缺文件的 worktree 往往跑不起来，用户修复后可重试。
      const detail = error instanceof Error ? error.message : String(error);
      emit(`[error] Failed to copy ${detail}\n`);
      await rollback(source.sourceRoot, bucketDir, realWorktreeRoot);
      return failure("copy-failed", detail);
    }
    log.info(
      undefined,
      `managed worktree created source=${source.sourceRoot} path=${realWorktreeRoot}`,
    );
    return {
      ok: true,
      worktree: {
        path: realWorktreeRoot,
        bucket: basename(bucketDir),
        sourceRoot: source.sourceRoot,
        head: commit,
        branchName: null,
        state: "ok",
        dirty: false,
      },
      cwd: source.relativeCwd ? join(realWorktreeRoot, source.relativeCwd) : realWorktreeRoot,
    };
  }

  async function resolveManagedWorktree(
    path: string,
  ): Promise<{ worktreeRoot: string; sourceRoot: string } | null> {
    const root = managedRoot();
    if (!(await pathExists(root))) return null;
    const parts = parseManagedWorktreePath(await realpathOr(root), await realpathOr(path));
    if (!parts || !(await pathExists(parts.worktreeRoot))) return null;
    const source = await resolveSourceRepository(parts.worktreeRoot);
    if (!source || !isSamePath(source.checkoutRoot, parts.worktreeRoot)) return null;
    const records = (await listPorcelain(source.sourceRoot)) ?? [];
    const registered = await Promise.all(records.map((record) => realpathOr(record.path)));
    if (!registered.some((registeredPath) => isSamePath(registeredPath, parts.worktreeRoot))) {
      return null;
    }
    return { worktreeRoot: parts.worktreeRoot, sourceRoot: source.sourceRoot };
  }

  async function remove(
    request: RemoveManagedWorktreeRequest,
  ): Promise<RemoveManagedWorktreeResult> {
    const managed = await resolveManagedWorktree(request.path);
    if (!managed || !isSamePath(managed.worktreeRoot, await realpathOr(request.path))) {
      return failure("not-managed");
    }
    if (!request.force) {
      // 预检只为给出结构化原因；真正的保护仍是不带 --force 的 git worktree remove。
      const status = await run(managed.worktreeRoot, [
        "status",
        "--porcelain",
        "-z",
        "--untracked-files=normal",
      ]);
      if (status.exitCode !== 0) return failure("git-failed", stderrDetail(status));
      if (status.stdout.length > 0) return failure("worktree-dirty");
    }

    // force 只由编排层在"没有任务使用"时传入（§3.11），用于清理中断留下的残留。
    const removed = await run(
      managed.sourceRoot,
      ["worktree", "remove", ...(request.force ? ["--force"] : []), managed.worktreeRoot],
      WORKTREE_REMOVE_TIMEOUT_MS,
    );
    if (removed.exitCode !== 0 || removed.timedOut) {
      return failure("git-failed", stderrDetail(removed));
    }
    // bucket 只放一个 worktree；为空才删除，非空（例如 Windows 上删除未完成）保留现场。
    await rmdir(dirname(managed.worktreeRoot)).catch(() => undefined);
    log.info(
      undefined,
      `managed worktree removed source=${managed.sourceRoot} path=${managed.worktreeRoot}`,
    );
    return { ok: true };
  }

  async function prune(request: PruneWorktreesRequest): Promise<void> {
    const source = await resolveSourceRepository(request.sourcePath);
    if (!source) return;
    await run(source.sourceRoot, ["worktree", "prune"]);
  }
  const listStartRefs = (request: { sourcePath: string }) =>
    readWorktreeStartRefs(run, resolveSourceRepository, request);

  return { list, create, remove, prune, resolveManagedWorktree, listStartRefs, isDirty };
}
