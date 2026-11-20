import { constants as fsConstants } from "node:fs";
import { copyFile, lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { GitCommandExecutionResult } from "../providers/gitCommandProvider.js";
import { pathExists, stderrDetail } from "./worktreeTopology.js";

/** 源仓库根目录中声明"新 worktree 需要拷贝哪些被忽略文件"的清单（§3.4）。 */
export const WORKTREE_INCLUDE_FILE = ".worktreeinclude";

/** 清单可能展开到很多文件；列举命令单独放宽输出与超时，避免默认 512KB 截断。 */
const FILE_LIST_OUTPUT_BYTES = 32 * 1024 * 1024;

const FILE_LIST_TIMEOUT_MS = 2 * 60_000;

/** check-ignore 按参数批量传入候选路径，控制单条命令行长度（Windows 命令行上限约 32K）。 */
const CHECK_IGNORE_BATCH = 100;

const COPY_CONCURRENCY = 16;

/** 写时复制优先（APFS / btrfs / xfs），不支持时由 Node 退回普通拷贝；EXCL 保证不覆盖已有文件。 */
const COPY_MODE = fsConstants.COPYFILE_EXCL | fsConstants.COPYFILE_FICLONE;

/** fork 带入改动时的临时补丁文件，写在 bucket 中（worktree 之外），应用后删除。 */
const CARRY_STAGED_PATCH = ".zcode-carry-staged.patch";

const CARRY_UNSTAGED_PATCH = ".zcode-carry-unstaged.patch";

class WorktreeCopyError extends Error {
  constructor(
    readonly relativePath: string,
    cause: unknown,
  ) {
    super(`${relativePath}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}
export {
  FILE_LIST_OUTPUT_BYTES,
  FILE_LIST_TIMEOUT_MS,
  CHECK_IGNORE_BATCH,
  COPY_CONCURRENCY,
  COPY_MODE,
  CARRY_STAGED_PATCH,
  CARRY_UNSTAGED_PATCH,
  WorktreeCopyError,
};

export type WorktreeRun = (
  cwd: string,
  args: string[],
  timeoutMs?: number,
  extra?: { maxOutputBytes?: number; onOutput?: (text: string) => void },
) => Promise<GitCommandExecutionResult>;
export function createWorktreeFileOperations(run: WorktreeRun) {
  /**
   * 计算需要拷贝的相对路径：被 .worktreeinclude 匹配、未跟踪，并且被仓库标准规则忽略。
   * 先用清单取候选（通常很少），再用 check-ignore 过滤，不列举仓库里全部被忽略的文件。
   */
  async function listIncludedIgnoredFiles(sourceRoot: string): Promise<string[]> {
    if (!(await pathExists(join(sourceRoot, WORKTREE_INCLUDE_FILE)))) return [];
    const candidates = await run(
      sourceRoot,
      ["ls-files", "--others", "--ignored", `--exclude-from=${WORKTREE_INCLUDE_FILE}`, "-z"],
      FILE_LIST_TIMEOUT_MS,
      { maxOutputBytes: FILE_LIST_OUTPUT_BYTES },
    );
    if (candidates.exitCode !== 0 || candidates.outputTruncated)
      throw new WorktreeCopyError(WORKTREE_INCLUDE_FILE, stderrDetail(candidates));
    const paths = candidates.stdout.split("\0").filter(Boolean);
    const ignored: string[] = [];
    for (let index = 0; index < paths.length; index += CHECK_IGNORE_BATCH) {
      const batch = paths.slice(index, index + CHECK_IGNORE_BATCH);
      const checked = await run(sourceRoot, ["check-ignore", "-z", "--", ...batch]);
      // exit 1 = 这一批都没有被忽略；其他非 0 是真实错误。
      if (checked.exitCode === 1) continue;
      if (checked.exitCode !== 0)
        throw new WorktreeCopyError(WORKTREE_INCLUDE_FILE, stderrDetail(checked));
      ignored.push(...checked.stdout.split("\0").filter(Boolean));
    }
    return ignored;
  }

  /** 目标路径的任一父目录是符号链接时拒绝，防止写到 worktree 之外。 */
  async function assertNoSymlinkParent(worktreeRoot: string, relativePath: string): Promise<void> {
    let current = worktreeRoot;
    for (const segment of dirname(relativePath)
      .split(/[\\/]/)
      .filter((part) => part && part !== ".")) {
      current = join(current, segment);
      const info = await lstat(current).catch(() => null);
      if (!info) return;
      if (info.isSymbolicLink()) throw new Error("path passes through a symbolic link");
    }
  }

  async function copyOne(sourceRoot: string, worktreeRoot: string, relativePath: string) {
    const from = join(sourceRoot, relativePath);
    // lstat：符号链接本身不跟随，直接跳过；只拷贝普通文件。
    const info = await lstat(from).catch(() => null);
    if (!info?.isFile()) return false;
    try {
      await assertNoSymlinkParent(worktreeRoot, relativePath);
      const to = join(worktreeRoot, relativePath);
      await mkdir(dirname(to), { recursive: true });
      await copyFile(from, to, COPY_MODE);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw new WorktreeCopyError(relativePath, error);
    }
  }

  async function copyIncludedFiles(sourceRoot: string, worktreeRoot: string): Promise<number> {
    const paths = await listIncludedIgnoredFiles(sourceRoot);
    let copied = 0;
    let next = 0;
    const worker = async () => {
      while (next < paths.length) {
        const relativePath = paths[next++]!;
        if (await copyOne(sourceRoot, worktreeRoot, relativePath)) copied += 1;
      }
    };
    await Promise.all(Array.from({ length: Math.min(COPY_CONCURRENCY, paths.length) }, worker));
    return copied;
  }

  /**
   * 读取 fork 要带入的改动（§3.6）。只执行只读命令，不改动父目录；以 commit 为基准，
   * 保证在以同一 commit 检出的 worktree 中应用时不会冲突。
   */
  async function readCarriedChanges(checkoutRoot: string, commit: string) {
    const read = async (args: string[]) => {
      const result = await run(checkoutRoot, args, FILE_LIST_TIMEOUT_MS, {
        maxOutputBytes: FILE_LIST_OUTPUT_BYTES,
      });
      if (result.exitCode !== 0 || result.outputTruncated)
        throw new Error(`git ${args[0]} failed: ${stderrDetail(result) || "output too large"}`);
      return result.stdout;
    };
    const staged = await read(["diff", "--cached", "--binary", commit]);
    const unstaged = await read(["diff", "--binary"]);
    const changed = new Set([
      ...(await read(["diff", "--cached", "--name-only", "-z", commit])).split("\0"),
      ...(await read(["diff", "--name-only", "-z"])).split("\0"),
    ]);
    const untracked = (await read(["ls-files", "--others", "--exclude-standard", "-z"]))
      .split("\0")
      .filter(Boolean);
    for (const path of untracked) changed.add(path);
    changed.delete("");
    return { staged, unstaged, untracked, count: changed.size };
  }

  /** 在新 worktree 中按暂存区划分应用补丁，并复制未跟踪文件；补丁文件放在 bucket 中、worktree 之外。 */
  async function applyCarriedChanges(
    checkoutRoot: string,
    bucketDir: string,
    worktreeRoot: string,
    changes: Awaited<ReturnType<typeof readCarriedChanges>>,
  ) {
    const apply = async (name: string, patch: string, args: string[]) => {
      if (!patch) return;
      const file = join(bucketDir, name);
      await writeFile(file, patch);
      try {
        const applied = await run(worktreeRoot, ["apply", ...args, "--binary", file]);
        if (applied.exitCode !== 0)
          throw new Error(`git apply failed: ${stderrDetail(applied) || applied.exitCode}`);
      } finally {
        await rm(file, { force: true });
      }
    };
    await apply(CARRY_STAGED_PATCH, changes.staged, ["--index"]);
    await apply(CARRY_UNSTAGED_PATCH, changes.unstaged, []);
    for (const path of changes.untracked) await copyOne(checkoutRoot, worktreeRoot, path);
  }
  return { copyIncludedFiles, readCarriedChanges, applyCarriedChanges };
}
