import { lstat, readdir, rm } from "node:fs/promises";
import { dirname, join, relative, isAbsolute, resolve, sep } from "node:path";

import type { SessionDataDirectory, SessionDataFilesPort } from "./contract.js";

export type { SessionDataDirectory, SessionDataFilesPort } from "./contract.js";

export interface NodeSessionDataFilesOptions {
  cliStorageRoot: string;
  /** 返回 `<cli>/memories/projects/<slug>-<hash>/memory`；删除其父目录。 */
  memoryRoot(directory: SessionDataDirectory): string;
}

/** 会话目录（每个会话一个子目录）与模型调用轨迹（每个会话一个文件）所在的位置。 */
const SESSION_DIRECTORY_ROOTS = ["artifacts", "exec", "agents", "sessions"] as const;
const MODEL_IO_DIRECTORIES = ["debug", "rollout"] as const;
const MEMORY_PROJECTS_PATH = ["memories", "projects"] as const;
// 会话 ID 直接拼进路径，必须是单个安全文件名段。
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/;

export function createNodeSessionDataFiles(
  options: NodeSessionDataFilesOptions,
): SessionDataFilesPort {
  const root = resolve(options.cliStorageRoot);
  const sessionPaths = (sessionId: string) => {
    if (!SAFE_SESSION_ID.test(sessionId)) throw new Error("session-data.invalid-session-id");
    return [
      ...SESSION_DIRECTORY_ROOTS.map((name) => join(root, name, sessionId)),
      ...MODEL_IO_DIRECTORIES.map((name) => join(root, name, `model-io-${sessionId}.jsonl`)),
    ];
  };
  const memoryPath = (directory: SessionDataDirectory) => {
    const projectFolder = dirname(options.memoryRoot(directory));
    const projects = join(root, ...MEMORY_PROJECTS_PATH);
    const inside = relative(projects, projectFolder);
    // 只允许 memories/projects 的直接子目录，防止解析结果越界删到别处。
    if (
      !inside ||
      inside.startsWith("..") ||
      isAbsolute(inside) ||
      inside.includes("/") ||
      inside.includes("\\")
    )
      throw new Error("session-data.memory-outside-storage");
    return projectFolder;
  };
  const measureAll = async (paths: string[]) => {
    // 修复原因：只对目标 lstat 无法阻止父目录 junction/symlink 被先行解析。
    // 整批测量前检查全部父级，避免删除已开始后才发现另一个目标指向存储根外。
    await Promise.all(paths.map((path) => validateStorageParents(root, path)));
    return (await Promise.all(paths.map(measurePath))).reduce((sum, bytes) => sum + bytes, 0);
  };
  const removeAll = async (paths: string[]) => {
    const bytes = await measureAll(paths);
    // rm 不跟随目录内的符号链接；顶层是链接时只删除链接本身。
    await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
    return bytes;
  };
  return {
    measureSession: async (sessionId) => measureAll(sessionPaths(sessionId)),
    removeSession: async (sessionId) => removeAll(sessionPaths(sessionId)),
    measureMemory: async (directory) => measureAll([memoryPath(directory)]),
    removeMemory: async (directory) => removeAll([memoryPath(directory)]),
  };
}

async function validateStorageParents(root: string, path: string): Promise<void> {
  let directory = root;
  const parents = relative(root, dirname(path)).split(sep).filter(Boolean);
  for (let index = 0; index <= parents.length; index += 1) {
    let stats;
    try {
      stats = await lstat(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (stats.isSymbolicLink()) throw new Error("session-data.storage-link-rejected");
    if (!stats.isDirectory()) throw new Error("session-data.invalid-storage-directory");
    if (index < parents.length) directory = join(directory, parents[index]!);
  }
}

async function measurePath(path: string): Promise<number> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  if (stats.isSymbolicLink()) return 0;
  if (!stats.isDirectory()) return stats.size;
  const entries = await readdir(path);
  const sizes = await Promise.all(entries.map((entry) => measurePath(join(path, entry))));
  return sizes.reduce((sum, bytes) => sum + bytes, 0);
}
