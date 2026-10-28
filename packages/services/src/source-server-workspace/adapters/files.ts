import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { ZCODE_USER_DATA_DIR_NAME } from "@zcode/shared";
import { WorkspaceAliasError } from "../contract.js";

export function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function bytesHash(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
export function workspaceDirectoryHash(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}
export function insidePath(parent: string, path: string): boolean {
  const distance = relative(parent, path);
  return (
    distance === "" ||
    (!isAbsolute(distance) &&
      distance !== ".." &&
      !distance.startsWith("..\\") &&
      !distance.startsWith("../"))
  );
}
function dataDirectory(name: string): boolean {
  return [".zcode", ".zcodium"].includes(name.toLowerCase());
}
export async function assertRoot(root: string): Promise<string> {
  if (!isAbsolute(root) || basename(root) !== ZCODE_USER_DATA_DIR_NAME)
    throw new WorkspaceAliasError("boundary-rejected");
  const normalized = resolve(root);
  let cursor = parse(normalized).root;
  // 最末组件安全不代表root安全：祖先junction可把授权根转向其它数据目录。
  for (const segment of relative(cursor, normalized).split(/[\\/]/).filter(Boolean)) {
    cursor = join(cursor, segment);
    if (cursor !== normalized && dataDirectory(segment))
      throw new WorkspaceAliasError("boundary-rejected");
    const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new WorkspaceAliasError("boundary-rejected");
    await realpath(cursor);
  }
  return realpath(normalized);
}
export async function rootIdentity(root: string): Promise<string> {
  const canonical = await assertRoot(root);
  const info = await lstat(root, { bigint: true });
  return hash({
    canonical: process.platform === "win32" ? canonical.toLowerCase() : canonical,
    dev: String(info.dev),
    ino: String(info.ino),
    birth: String(info.birthtimeNs),
  });
}
export async function assertSafePath(
  root: string,
  target: string,
  missing = false,
): Promise<boolean> {
  if (!isAbsolute(target)) throw new WorkspaceAliasError("boundary-rejected");
  const normalizedRoot = resolve(root);
  const normalized = resolve(target);
  if (!insidePath(normalizedRoot, normalized)) throw new WorkspaceAliasError("boundary-rejected");
  const canonicalRoot = await assertRoot(normalizedRoot);
  let cursor = normalizedRoot;
  for (const segment of relative(normalizedRoot, normalized).split(/[\\/]/).filter(Boolean)) {
    if (dataDirectory(segment)) throw new WorkspaceAliasError("boundary-rejected");
    cursor = join(cursor, segment);
    let info;
    try {
      info = await lstat(cursor, { bigint: true });
    } catch (error) {
      if (missing && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (
      info.isSymbolicLink() ||
      (!info.isFile() && !info.isDirectory()) ||
      (info.isFile() && info.nlink !== 1n)
    )
      throw new WorkspaceAliasError("boundary-rejected");
    if (!insidePath(canonicalRoot, await realpath(cursor)))
      throw new WorkspaceAliasError("boundary-rejected");
  }
  return true;
}
function fileIdentity(info: { dev: bigint; ino: bigint; birthtimeNs: bigint }): string {
  return hash({ dev: String(info.dev), ino: String(info.ino), birth: String(info.birthtimeNs) });
}
export interface SafeFile {
  handle: FileHandle;
  identity: string;
  assertCurrent(): Promise<void>;
}
export async function openSafe(root: string, path: string, write = false): Promise<SafeFile> {
  await assertSafePath(root, path);
  const before = await lstat(path, { bigint: true });
  const handle = await open(
    path,
    (write ? constants.O_RDWR : constants.O_RDONLY) | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || fileIdentity(before) !== fileIdentity(opened))
      throw new WorkspaceAliasError("boundary-rejected");
    const identity = hash({ path: resolve(path), generation: fileIdentity(opened) });
    const assertCurrent = async () => {
      await assertSafePath(root, path);
      const current = await lstat(path, { bigint: true });
      const held = await handle.stat({ bigint: true });
      // 路径换成另一个普通文件也不是原介质；只复查isFile会漏掉这种替换。
      if (
        !held.isFile() ||
        held.nlink !== 1n ||
        fileIdentity(current) !== fileIdentity(opened) ||
        fileIdentity(held) !== fileIdentity(opened)
      )
        throw new WorkspaceAliasError("boundary-rejected");
    };
    await assertCurrent();
    return { handle, identity, assertCurrent };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
export async function readSafe(root: string, path: string, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  const file = await openSafe(root, path);
  try {
    const data = await file.handle.readFile();
    signal?.throwIfAborted();
    await file.assertCurrent();
    return data;
  } finally {
    await file.handle.close();
  }
}
export async function makeDirectory(root: string, path: string): Promise<void> {
  await assertSafePath(root, path, true);
  await mkdir(path, { recursive: true, mode: 0o700 });
  await assertSafePath(root, path);
}
export async function syncDirectory(path: string): Promise<void> {
  // Windows Node不能打开目录做fsync；不把POSIX mode/fsync声明为Windows ACL或断电原子性。
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export async function writeAtomic(
  root: string,
  path: string,
  data: string | Uint8Array,
): Promise<void> {
  await makeDirectory(root, dirname(path));
  await assertSafePath(root, path, true);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await assertSafePath(root, temporary);
    await assertSafePath(root, path, true);
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(temporary, { force: true });
  }
}
export function operationError(error: unknown): WorkspaceAliasError {
  if (error instanceof WorkspaceAliasError) return error;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOSPC" || code === "EDQUOT") return new WorkspaceAliasError("storage-full");
  if (code === "EACCES" || code === "EPERM") return new WorkspaceAliasError("permission-denied");
  if ((error as { name?: string } | null)?.name === "AbortError")
    return new WorkspaceAliasError("cancelled");
  return new WorkspaceAliasError("io-failed");
}
export const yieldLoop = () => new Promise<void>((done) => setImmediate(done));
