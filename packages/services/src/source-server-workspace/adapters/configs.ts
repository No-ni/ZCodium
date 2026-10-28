import { readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { WorkspaceAliasError } from "../contract.js";
import type { ConfigImage } from "../domain/images.js";
import {
  assertSafePath,
  bytesHash,
  hash,
  makeDirectory,
  readSafe,
  writeAtomic,
  yieldLoop,
  syncDirectory,
} from "./files.js";

export async function readConfig(
  root: string,
  image: Pick<ConfigImage, "root" | "workspaceKey" | "directory">,
  signal?: AbortSignal,
): Promise<ConfigImage> {
  const exists = await assertSafePath(root, image.directory, true);
  const entries: ConfigImage["entries"] = [];
  async function visit(path: string, relativePath: string): Promise<void> {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      signal?.throwIfAborted();
      const absolute = join(path, entry.name);
      const relative = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      await assertSafePath(root, absolute);
      if (entry.isDirectory()) {
        entries.push({ path: relative, kind: "directory", hash: hash("directory") });
        await visit(absolute, relative);
      } else if (entry.isFile()) {
        const content = await readSafe(root, absolute, signal);
        entries.push({
          path: relative,
          kind: "file",
          content: content.toString("base64"),
          hash: bytesHash(content),
        });
      } else throw new WorkspaceAliasError("boundary-rejected");
      await yieldLoop();
    }
  }
  if (exists) await visit(image.directory, "");
  return { ...image, exists, entries };
}
export function configDigest(image: ConfigImage): string {
  return hash({
    ...image,
    entries: [...image.entries].sort((left, right) => left.path.localeCompare(right.path)),
  });
}
export async function materialize(
  root: string,
  target: string,
  image: ConfigImage,
  signal?: AbortSignal,
): Promise<void> {
  await makeDirectory(root, target);
  if (!image.exists) return;
  for (const entry of image.entries) {
    signal?.throwIfAborted();
    const path = join(target, ...entry.path.split("/"));
    if (entry.kind === "directory") await makeDirectory(root, path);
    else {
      const bytes = Buffer.from(entry.content ?? "", "base64");
      if (bytesHash(bytes) !== entry.hash) throw new WorkspaceAliasError("backup-failed");
      await writeAtomic(root, path, bytes);
    }
  }
  const copy = await readConfig(root, { ...image, directory: target }, signal);
  if (configDigest({ ...copy, directory: image.directory }) !== configDigest(image))
    throw new WorkspaceAliasError("backup-failed");
}
export interface ConfigRename {
  from: string;
  to: string;
  image: ConfigImage;
}
export function configOperations(
  root: string,
  before: readonly ConfigImage[],
  after: readonly ConfigImage[],
): ConfigRename[] {
  const operations: ConfigRename[] = [];
  for (let index = 0; index < before.length; index++) {
    const original = before[index]!;
    const output = after[index]!;
    if (configDigest(original) === configDigest(output)) continue;
    if (original.exists)
      operations.push({
        from: original.directory,
        to: join(root, "retired", String(index)),
        image: original,
      });
    if (output.exists)
      operations.push({
        from: join(root, "prepared", String(index)),
        to: output.directory,
        image: output,
      });
  }
  return operations;
}
export async function runRename(
  root: string,
  operation: ConfigRename,
  signal?: AbortSignal,
  beforeRename?: () => Promise<void>,
): Promise<void> {
  const source = await readConfig(root, { ...operation.image, directory: operation.from }, signal);
  const destination = await readConfig(
    root,
    { ...operation.image, directory: operation.to },
    signal,
  );
  const expected = configDigest(operation.image);
  const digest = (image: ConfigImage) =>
    configDigest({ ...image, directory: operation.image.directory });
  if (!source.exists && destination.exists && digest(destination) === expected) return;
  if (!source.exists || destination.exists || digest(source) !== expected)
    throw new WorkspaceAliasError("state-diverged");
  await assertSafePath(root, operation.from);
  await assertSafePath(root, operation.to, true);
  await makeDirectory(root, join(operation.to, ".."));
  await beforeRename?.();
  signal?.throwIfAborted();
  await rename(operation.from, operation.to);
  await syncDirectory(join(operation.from, ".."));
  await syncDirectory(join(operation.to, ".."));
  const moved = await readConfig(root, { ...operation.image, directory: operation.to }, signal);
  if (digest(moved) !== expected) throw new WorkspaceAliasError("state-diverged");
}
