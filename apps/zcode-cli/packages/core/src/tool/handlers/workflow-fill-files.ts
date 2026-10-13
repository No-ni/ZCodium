// 被拒内联函数体的数据根存储：7 天 mtime 保留，每次写入前 await best-effort 清理。
// 不在 run 结束时删除，保证长会话仍可按返回的 path 编辑重试；不写项目工作树。
import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { SAVED_WORKFLOW_FILE_EXTENSION } from "@zcode/contracts";
import { ZCODE_USER_DATA_DIR_NAME } from "@zcode/shared";
import { workflowDraftSlug } from "./workflow-drafts.js";

export const WORKFLOW_FILL_FILE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 1_000;

export function resolveWorkflowFillFilesRoot(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): string {
  return path.resolve(
    env.ZCODE_DATA_BASE_DIR?.trim() || home,
    ZCODE_USER_DATA_DIR_NAME,
    "workflow-fills",
  );
}

export interface WorkflowFillFileScope {
  root?: string;
  sessionId?: string;
  runId: string;
  holeId: string;
}
export interface WriteWorkflowFillFileInput extends WorkflowFillFileScope {
  runName?: string;
  holeName: string;
  source: string;
  now?: number;
  retentionMs?: number;
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function scopeParts(scope: WorkflowFillFileScope): string[] {
  // slug 会把 session/a 与 sessiona 压成同名；隔离必须用完整身份哈希，名字只当可读标签。
  return [hash(JSON.stringify(scope.sessionId ?? null)), hash(scope.runId), hash(scope.holeId)];
}
function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

/** 用户自备路径仍可用；托管 fill 必须属于当前 session/run/site，禁止路径遍历与链接绕过。 */
export async function resolveWorkflowFillFilePath(
  input: string,
  cwd: string,
  scope: WorkflowFillFileScope,
): Promise<string> {
  if (input.split(/[\\/]/u).includes("..")) throw new Error("fill path traversal is not allowed");
  const file = path.resolve(cwd, input);
  const root = path.resolve(scope.root ?? resolveWorkflowFillFilesRoot());
  const resolvedFile = await realpath(file);
  const resolvedRoot = await realpath(root).catch(() => root);
  if (inside(root, file) || inside(resolvedRoot, resolvedFile)) {
    const ownedDir = path.join(resolvedRoot, ...scopeParts(scope));
    if (!inside(ownedDir, resolvedFile))
      throw new Error("fill file belongs to another session/run/site scope");
    // 即使链接指向同 scope 也不接收，避免批准前后目标被换掉；root 自身允许宿主配置的链接。
    const lexicalFile = path.join(resolvedRoot, path.relative(root, file));
    if (lexicalFile !== resolvedFile) throw new Error("managed fill symlink is not allowed");
  }
  return file;
}

/** 独占创建，内容相同复用；用户编辑过同名文件则顺延，永不覆盖。写不成返回 undefined。 */
export async function writeWorkflowFillFile(
  input: WriteWorkflowFillFileInput,
): Promise<string | undefined> {
  const root = path.resolve(input.root ?? resolveWorkflowFillFilesRoot());
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await pruneWorkflowFillFiles(root, {
      ...(input.now === undefined ? {} : { now: input.now }),
      ...(input.retentionMs === undefined ? {} : { retentionMs: input.retentionMs }),
    });
    let dir = await realpath(root);
    for (const part of scopeParts(input)) {
      dir = path.join(dir, part);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      // 已存在的链接目录会绕过身份隔离；只接受普通目录，不跟随符号链接。
      if (!(await lstat(dir)).isDirectory()) return undefined;
    }
    // 标签按码点缩短，连多字节中文也不超过文件系统单个目录项的字节上限。
    const label = (name: string) => Array.from(workflowDraftSlug(name)).slice(0, 16).join("");
    const stem = `${label(input.runName ?? input.runId)}.${label(input.holeName)}.${hash(input.source)}`;
    const pending = path.join(dir, `.${randomUUID()}.pending`);
    try {
      // 直接 wx 写目标会让并发 EEXIST 读到半份正文；先写完再 link 原子独占发布，才可复用。
      await writeFile(pending, input.source, { encoding: "utf8", flag: "wx", mode: 0o600 });
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const suffix = attempt === 1 ? "" : `-${attempt}`;
        const file = path.join(dir, `${stem}${suffix}${SAVED_WORKFLOW_FILE_EXTENSION}`);
        try {
          await link(pending, file);
          return file;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          if (!(await lstat(file)).isFile()) continue;
          if ((await readFile(file, "utf8")) === input.source) return file;
        }
      }
    } finally {
      await unlink(pending).catch(() => undefined);
    }
  } catch {
    // 数据根只读/盘满不是补全的新拒绝原因，调用方继续返回真实编译诊断。
  }
  return undefined;
}

/** 固定三层身份目录，忽略符号链接与非 fill 文件；清理失败不影响编译诊断。 */
export async function pruneWorkflowFillFiles(
  root: string,
  options: { now?: number; retentionMs?: number } = {},
): Promise<number> {
  const cutoff =
    (options.now ?? Date.now()) - (options.retentionMs ?? WORKFLOW_FILL_FILE_RETENTION_MS);
  async function visit(dir: string, depth: number): Promise<number> {
    let removed = 0;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (depth < 3 && entry.isDirectory()) {
        removed += await visit(file, depth + 1);
      } else if (
        depth === 3 &&
        entry.isFile() &&
        (entry.name.endsWith(SAVED_WORKFLOW_FILE_EXTENSION) ||
          /^\.[0-9a-f-]{36}\.pending$/u.test(entry.name))
      ) {
        try {
          const info = await lstat(file);
          if (info.isFile() && info.mtimeMs < cutoff) {
            await unlink(file);
            removed += 1;
          }
        } catch {
          // 并发删除或权限变化只意味着下次再清，不影响本次重试。
        }
      }
    }
    return removed;
  }
  return visit(root, 0);
}
