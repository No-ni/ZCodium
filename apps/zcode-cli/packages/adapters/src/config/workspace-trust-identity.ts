import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  parseManagedWorktreePath,
  resolveManagedWorktreeRoot,
  resolveWorkspaceHookTrustIdentity,
  type WorkspaceHookTrustIdentityFs,
} from "@zcode/shared/managed-worktree";

// ── Hook Trust identity（docs/specs/workspace-hook-trust.md D23）──
// 唯一 resolver 在 @zcode/shared/managed-worktree；这里只提供 Node 只读文件端口与数据根目录。

const ZCODE_DATA_BASE_DIR_ENV_KEY = "ZCODE_DATA_BASE_DIR";

/** 与 Host getDataBaseDir 同规则：ZCODE_DATA_BASE_DIR 优先，空值回落 homedir。 */
export function resolveZCodeDataBaseDir(
  env: Record<string, string | undefined> = process.env,
): string {
  return env[ZCODE_DATA_BASE_DIR_ENV_KEY]?.trim() || homedir();
}

const nodeTrustIdentityFs: WorkspaceHookTrustIdentityFs = {
  readFile: (path) => readFile(path, "utf8"),
  realpath: (path) => realpath(path),
  stat: async (path) => {
    try {
      const info = await stat(path);
      return { isFile: info.isFile(), isDirectory: info.isDirectory() };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  },
};

/**
 * 计算 workspace 的 Hook Trust identity。远程 identity 原样返回；本地受管 worktree 严格校验通过后
 * 归一为源仓库对应路径；其余情况返回 workspacePath（调用方负责传入已规范化的路径）。
 */
export function resolveWorkspaceHookTrustIdentityForWorkspace(input: {
  workspacePath: string;
  workspaceIdentity?: string;
  env?: Record<string, string | undefined>;
}): Promise<string> {
  return resolveWorkspaceHookTrustIdentity(
    {
      workspacePath: input.workspacePath,
      ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
      dataBaseDir: resolveZCodeDataBaseDir(input.env),
    },
    nodeTrustIdentityFs,
  );
}

/** 本地会话目录相对 workspace 目录的文件系统关系，见 classifyLocalSessionDirectory。 */
export type LocalSessionDirectoryRelation = "same" | "worktree" | "removed-worktree" | "other";

/**
 * 本地会话目录与 workspace 目录的文件系统关系（docs/git/worktree.md §9.3 归属判定）：
 * - same：同一个真实目录（realpath 比较，吸收 Host key 保留的输入大小写与磁盘真实大小写的差异）；
 * - worktree：目录是受管 worktree，严格 resolver 映射回该真实目录；
 * - removed-worktree：目录位于受管 worktree 布局内但已不存在，文件系统无法证明归属，调用方只能用
 *   创建时持久化的身份兜底；
 * - other：不属于。
 * 只做文件系统判定，不使用 projectID：projectID 是有损 slug（转小写、替换字符、截断），
 * 不同项目可能相同，不能作为会执行代码的冷恢复/激活路径的归属证明。
 */
export async function classifyLocalSessionDirectory(input: {
  directory: string;
  workspacePath: string;
  env?: Record<string, string | undefined>;
}): Promise<LocalSessionDirectoryRelation> {
  const directory = resolve(input.directory);
  const workspacePath = resolve(input.workspacePath);
  if (directory === workspacePath) return "same";
  const [realDirectory, realWorkspace] = await Promise.all([
    realpathOrNull(directory),
    realpathOrNull(workspacePath),
  ]);
  if (realDirectory !== null && realDirectory === realWorkspace) return "same";
  const dataBaseDir = resolveZCodeDataBaseDir(input.env);
  if (realDirectory === null) {
    // 会话 cwd 落盘时就是 realpath；受管根目录本身可能经过软链，两种形态都认。
    const managedRoot = resolveManagedWorktreeRoot(dataBaseDir);
    const realManagedRoot = (await realpathOrNull(managedRoot)) ?? managedRoot;
    return parseManagedWorktreePath(realManagedRoot, directory) ||
      parseManagedWorktreePath(managedRoot, directory)
      ? "removed-worktree"
      : "other";
  }
  if (realWorkspace === null) return "other";
  const mapped = await resolveWorkspaceHookTrustIdentity(
    { workspacePath: directory, dataBaseDir },
    nodeTrustIdentityFs,
  );
  if (mapped === directory) return "other";
  return (await realpathOrNull(mapped)) === realWorkspace ? "worktree" : "other";
}

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}
export { ZCODE_DATA_BASE_DIR_ENV_KEY, nodeTrustIdentityFs, realpathOrNull };
