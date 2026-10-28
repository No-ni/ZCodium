import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  MAX_FILE_BYTES,
  OfficeError,
  extensionList,
  kindOf,
  type DocKind,
} from "#office/contract.ts";
import { TITLE } from "#office/wording.ts";

function inside(root: string, target: string) {
  const rel = relative(root, target);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

const toPosix = (path: string) => path.split(sep).join("/");

export interface LoadedFile {
  /** Workspace-relative path with forward slashes. */
  path: string;
  kind: DocKind;
  bytes: Uint8Array;
  revision: string;
  mtimeMs: number;
}

export interface WorkspaceFiles {
  /** Normalise a user or model path to a workspace-relative one; throws outside the workspace. */
  resolve(input: string): Promise<{ path: string; absolute: string; kind: DocKind }>;
  load(input: string): Promise<LoadedFile>;
  /** Cheap change check: size + mtime, without reading the file. */
  fingerprint(input: string): Promise<string>;
  list(options?: {
    limit?: number;
  }): Promise<{ path: string; kind: DocKind; bytes: number; mtimeMs: number }[]>;
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  ".venv",
  "__pycache__",
]);

export function createWorkspaceFiles(workspace: string): WorkspaceFiles {
  let rootPromise: Promise<string> | undefined;
  const root = () => (rootPromise ??= realpath(workspace));

  async function resolvePath(input: string) {
    if (typeof input !== "string" || !input.trim() || input.includes("\0"))
      throw new OfficeError("invalid_path", "A document path is required.");
    const base = await root();
    const target = resolve(base, input.trim());
    if (!inside(base, target) && target !== base)
      throw new OfficeError("path_outside_workspace", `Path is outside this workspace: ${input}`);
    const kind = kindOf(target);
    if (!kind)
      throw new OfficeError(
        "unsupported_type",
        `Unsupported file type: ${input}. ${TITLE} opens ${extensionList()} files.`,
      );
    let actual: string;
    try {
      actual = await realpath(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new OfficeError("not_found", `File not found: ${toPosix(relative(base, target))}`);
      throw error;
    }
    if (!inside(base, actual))
      throw new OfficeError("path_outside_workspace", "The path links outside this workspace.");
    return { path: toPosix(relative(base, target)), absolute: actual, kind };
  }

  async function checkedStat(absolute: string, path: string) {
    const info = await stat(absolute);
    if (!info.isFile()) throw new OfficeError("not_found", `Not a file: ${path}`);
    if (info.size > MAX_FILE_BYTES)
      throw new OfficeError(
        "file_too_large",
        `${path} is ${(info.size / 1024 / 1024).toFixed(1)} MiB; the limit is ${MAX_FILE_BYTES / 1024 / 1024} MiB.`,
      );
    return info;
  }

  return {
    resolve: resolvePath,
    async load(input) {
      const { path, absolute, kind } = await resolvePath(input);
      const info = await checkedStat(absolute, path);
      const bytes = new Uint8Array(await readFile(absolute));
      // stat 与读取间文件可能增长；保留前置检查并再次拒绝实际超量，不让 parser 收到超限内容。
      if (bytes.byteLength > MAX_FILE_BYTES)
        throw new OfficeError("file_too_large", "The document exceeds the supported size limit.");
      const revision = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
      return { path, kind, bytes, revision, mtimeMs: info.mtimeMs };
    },
    async fingerprint(input) {
      const { path, absolute } = await resolvePath(input);
      const info = await checkedStat(absolute, path);
      return `${info.size}:${info.mtimeMs}`;
    },
    async list({ limit = 500 } = {}) {
      const base = await root();
      const found: { path: string; kind: DocKind; bytes: number; mtimeMs: number }[] = [];
      const queue: { dir: string; depth: number }[] = [{ dir: base, depth: 0 }];
      let visited = 0;
      // Breadth-first so shallow documents win when the workspace is large.
      while (queue.length && found.length < limit && visited < 5000) {
        const { dir, depth } = queue.shift()!;
        visited++;
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
          if (entry.name.startsWith(".") || entry.name.startsWith("~$")) continue;
          const full = join(dir, entry.name);
          if (entry.isDirectory()) {
            if (depth < 8 && !SKIP_DIRS.has(entry.name))
              queue.push({ dir: full, depth: depth + 1 });
          } else if (entry.isFile()) {
            const kind = kindOf(entry.name);
            if (!kind) continue;
            const info = await lstat(full).catch(() => null);
            if (!info) continue;
            found.push({
              path: toPosix(relative(base, full)),
              kind,
              bytes: info.size,
              mtimeMs: info.mtimeMs,
            });
            if (found.length >= limit) break;
          }
        }
      }
      return found;
    },
  };
}
