import { realpath, stat } from "node:fs/promises";
import type { ManagedWorktreeErrorCode } from "@zcode/shared";
import type { GitCommandExecutionResult } from "../providers/gitCommandProvider.js";

const STDERR_DETAIL_LIMIT = 2_000;

interface SourceRepository {
  /** sourcePath 所在 checkout 的 toplevel（执行 worktree add 的位置）。 */
  checkoutRoot: string;
  /** 主仓库 toplevel（common dir 的父目录）。 */
  sourceRoot: string;
  /** sourcePath 相对 checkoutRoot 的路径，用于计算 worktree 中的任务 cwd。 */
  relativeCwd: string;
}

interface PorcelainWorktree {
  path: string;
  head: string | null;
  branchName: string | null;
  prunable: boolean;
  bare: boolean;
}

function failure(code: ManagedWorktreeErrorCode, detail?: string) {
  return { ok: false as const, error: { code, ...(detail ? { detail } : {}) } };
}

function stderrDetail(result: GitCommandExecutionResult): string {
  return (result.stderr || result.stdout).trim().slice(0, STDERR_DETAIL_LIMIT);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function realpathOr(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/** 解析 `git worktree list --porcelain -z`：字段以 NUL 分隔，记录之间多一个空字段。 */
export function parseWorktreeListPorcelain(output: string): PorcelainWorktree[] {
  const records: PorcelainWorktree[] = [];
  let current: PorcelainWorktree | null = null;
  for (const field of output.split("\0")) {
    if (field === "") {
      if (current) records.push(current);
      current = null;
      continue;
    }
    const spaceIndex = field.indexOf(" ");
    const key = spaceIndex < 0 ? field : field.slice(0, spaceIndex);
    const value = spaceIndex < 0 ? "" : field.slice(spaceIndex + 1);
    if (key === "worktree") {
      if (current) records.push(current);
      current = { path: value, head: null, branchName: null, prunable: false, bare: false };
      continue;
    }
    if (!current) continue;
    if (key === "HEAD") current.head = value || null;
    else if (key === "branch") current.branchName = value.replace(/^refs\/heads\//, "");
    else if (key === "prunable") current.prunable = true;
    else if (key === "bare") current.bare = true;
  }
  if (current) records.push(current);
  return records;
}
export {
  STDERR_DETAIL_LIMIT,
  type SourceRepository,
  type PorcelainWorktree,
  failure,
  stderrDetail,
  pathExists,
  realpathOr,
};
