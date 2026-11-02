import { ZCODE_USER_DATA_DIR_NAME } from "@zcode/shared";
/* eslint-disable max-lines -- skill 同步服务集中维护候选扫描、远端判重和导入流程，避免拆分时扩大远端同步回归面。 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { SKILL_DATA_SYNC_MAX_ITEM_BYTES } from "@zcode/shared";
import type { ISkillSyncService } from "./skillSync.js";
import {
  MAX_SKILL_SCAN_DEPTH,
  shouldWalkSkillDirectoryEntry,
  walkSkillMarkdownPaths,
} from "../skills/skillDiscoveryWalk.js";
import { createSkillDataSyncMethods } from "../data-sync/node.js";

const SKILL_FILE_NAME = "SKILL.md";
const DEFAULT_MAX_ARCHIVE_BYTES = SKILL_DATA_SYNC_MAX_ITEM_BYTES;
// 大目录体积扫描按并发窗口收 stat，避免逐项 await 把 O(n) Promise 串起来。
const SKILL_SIZE_SCAN_IO_CONCURRENCY = 8;

/** 用户级技能候选：path 指向技能目录下的 SKILL.md。 */
export interface UserSkillCandidate {
  name: string;
  directoryName: string;
  description: string;
  path: string;
}

export function createSkillSyncService(options?: { maxArchiveBytes?: number }): ISkillSyncService {
  const maxArchiveBytes = options?.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES;
  // 数据同步：单个技能目录的大小上限，默认 20MB。
  return createSkillDataSyncMethods({ maxItemBytes: maxArchiveBytes });
}

export function resolveUserHomeDir(): string {
  return process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || homedir();
}

// 数据同步（skillDataSync）复用同一入口，必须走本仓 `.zcodium` 数据根，不能退回官方 `.zcode`。
export function getUserZcodeSkillRoot(): string {
  return join(resolveUserHomeDir(), ZCODE_USER_DATA_DIR_NAME, "skills");
}

function getUserAgentsSkillRoot(): string {
  return join(resolveUserHomeDir(), ".agents", "skills");
}

/**
 * 用户级技能候选：`~/.zcode/skills` 优先，`~/.agents/skills` 中同目录名或同 name 的项剔除，再按 realpath 去重。
 * 文件数与字节签名由数据同步的 list 自己计算。
 */
export async function collectUserSkillCandidates(): Promise<UserSkillCandidate[]> {
  const seenSkillRealpaths = new Set<string>();
  const userZcodeSkillRoot = getUserZcodeSkillRoot();
  const rawZcodeCandidates = await collectUserSkillCandidatesInRoot(userZcodeSkillRoot);
  const zcodeDirectoryNames = await collectCoveredSkillDirectoryNamesInRoot(userZcodeSkillRoot);
  const zcodeSkillNameKeys = new Set(
    rawZcodeCandidates.map((candidate) => normalizeSkillNameKey(candidate.name)),
  );
  const zcodeCandidates = await dedupeCandidatesByCanonicalSkillPath(
    rawZcodeCandidates,
    seenSkillRealpaths,
  );
  const agentsCandidates = await dedupeCandidatesByCanonicalSkillPath(
    (await collectUserSkillCandidatesInRoot(getUserAgentsSkillRoot())).filter(
      (candidate) =>
        !zcodeDirectoryNames.has(candidate.directoryName) &&
        !zcodeSkillNameKeys.has(normalizeSkillNameKey(candidate.name)),
    ),
    seenSkillRealpaths,
  );

  return [...zcodeCandidates, ...agentsCandidates].sort((left, right) =>
    left.directoryName.localeCompare(right.directoryName),
  );
}

async function dedupeCandidatesByCanonicalSkillPath(
  candidates: UserSkillCandidate[],
  seenSkillRealpaths: Set<string>,
): Promise<UserSkillCandidate[]> {
  const result: UserSkillCandidate[] = [];
  for (const candidate of candidates) {
    const canonicalPath = await realpath(candidate.path).catch(() => candidate.path);
    if (seenSkillRealpaths.has(canonicalPath)) {
      continue;
    }
    seenSkillRealpaths.add(canonicalPath);
    result.push(candidate);
  }
  return result;
}

async function collectUserSkillCandidatesInRoot(root: string): Promise<UserSkillCandidate[]> {
  if (!existsSync(root)) {
    return [];
  }
  const candidates: UserSkillCandidate[] = [];
  for await (const skillPath of walkSkillMarkdownPaths(root)) {
    const directoryPath = dirname(skillPath);
    const relativePath = normalizeSkillDirectoryRelativePath(root, directoryPath);
    if (!relativePath) {
      continue;
    }
    const content = await readSkillFileOrNull(skillPath);
    if (content !== null) {
      const metadata = parseSkillMetadata(content, basename(relativePath));
      candidates.push({
        name: metadata.name,
        directoryName: relativePath,
        description: metadata.description,
        path: skillPath,
      });
    }
  }

  // 远端同步候选必须复用设置页已有的有界扫描策略；
  // 自己维护递归会漏掉 MAX_SKILL_SCAN_DEPTH 和软链 realpath 去重，遇到环形目录软链会卡住。
  return candidates.sort((left, right) => left.directoryName.localeCompare(right.directoryName));
}

async function collectCoveredSkillDirectoryNamesInRoot(root: string): Promise<Set<string>> {
  const directoryNames = new Set<string>();
  if (!existsSync(root)) {
    return directoryNames;
  }
  const stack: Array<{ directoryPath: string; relativePath: string; depth: number }> = [
    { directoryPath: root, relativePath: "", depth: 0 },
  ];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    const skillFilePath = join(current.directoryPath, SKILL_FILE_NAME);
    if (current.relativePath && (await readSkillFileOrNull(skillFilePath))) {
      directoryNames.add(current.relativePath);
    }
    if (current.depth >= MAX_SKILL_SCAN_DEPTH) {
      continue;
    }
    let entries;
    try {
      entries = await readdir(current.directoryPath, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
    for (const entry of entries) {
      if (!shouldWalkSkillDirectoryEntry(entry.name)) {
        continue;
      }
      const entryPath = join(current.directoryPath, entry.name);
      const isDirectory =
        entry.isDirectory() ||
        (entry.isSymbolicLink() && (await stat(entryPath).catch(() => undefined))?.isDirectory());
      if (!isDirectory) {
        continue;
      }
      stack.push({
        directoryPath: entryPath,
        relativePath: joinSkillRelativePath(current.relativePath, entry.name),
        depth: current.depth + 1,
      });
    }
  }

  return directoryNames;
}

function normalizeSkillDirectoryRelativePath(root: string, directoryPath: string): string {
  return relative(root, directoryPath).replaceAll("\\", "/");
}

export function normalizeSkillNameKey(name: string): string {
  return name.trim().toLowerCase();
}

function joinSkillRelativePath(parent: string, child: string): string {
  return parent ? `${parent}/${child}` : child;
}

export async function readSkillFileOrNull(skillPath: string): Promise<string | null> {
  try {
    return await readFile(skillPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function parseSkillMetadata(
  content: string,
  fallbackName: string,
): {
  name: string;
  description: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);
  if (!match) {
    return { name: fallbackName, description: "" };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(match[1] ?? "");
  } catch {
    return { name: fallbackName, description: "" };
  }
  const metadata = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const name =
    typeof metadata.name === "string" && metadata.name.trim() ? metadata.name.trim() : fallbackName;
  const description = typeof metadata.description === "string" ? metadata.description.trim() : "";
  return { name, description };
}

function createCandidateId(skillDirectoryPath: string): string {
  return createHash("sha256").update(skillDirectoryPath).digest("hex");
}

async function computeRecursiveSize(rootPath: string): Promise<number> {
  const pendingPaths: Array<string | undefined> = [rootPath];
  const visitedDirectories = new Set<string>();
  let nextPathIndex = 0;
  let totalBytes = 0;
  let hasError = false;
  let firstError: unknown;

  async function visitPath(path: string): Promise<void> {
    const pathStat = await lstat(path);
    if (pathStat.isSymbolicLink()) {
      const targetStat = await stat(path).catch(() => null);
      if (!targetStat) return;
      if (targetStat.isFile()) {
        totalBytes += targetStat.size;
        return;
      }
      if (!targetStat.isDirectory()) return;
    } else if (pathStat.isFile()) {
      totalBytes += pathStat.size;
      return;
    } else if (!pathStat.isDirectory()) {
      return;
    }

    const canonicalPath = await realpath(path).catch(() => path);
    if (visitedDirectories.has(canonicalPath)) return;
    visitedDirectories.add(canonicalPath);
    for (const child of await readdir(path, { withFileTypes: true })) {
      pendingPaths.push(join(path, child.name));
    }
  }

  return await new Promise<number>((resolve, reject) => {
    let active = 0;
    let settled = false;
    const pump = () => {
      // Bug 原因：逐层 Promise.all 会把宽目录全部子项同时提交，嵌套层数还会叠加在途 IO。
      // 修复依据：一次遍历共用有界游标队列；消费后释放路径引用，出错时停止派发并等待在途 IO 排空。
      while (
        !hasError &&
        active < SKILL_SIZE_SCAN_IO_CONCURRENCY &&
        nextPathIndex < pendingPaths.length
      ) {
        const currentIndex = nextPathIndex++;
        const path = pendingPaths[currentIndex];
        pendingPaths[currentIndex] = undefined;
        if (!path) continue;
        if (nextPathIndex >= 1024 && nextPathIndex * 2 >= pendingPaths.length) {
          pendingPaths.splice(0, nextPathIndex);
          nextPathIndex = 0;
        }
        active += 1;
        void visitPath(path)
          .catch((error: unknown) => {
            if (!hasError) {
              hasError = true;
              firstError = error;
            }
          })
          .finally(() => {
            active -= 1;
            pump();
          });
      }

      if (!settled && active === 0 && (hasError || nextPathIndex >= pendingPaths.length)) {
        settled = true;
        pendingPaths.length = 0;
        if (hasError) reject(firstError);
        else resolve(totalBytes);
      }
    };

    pump();
  });
}
