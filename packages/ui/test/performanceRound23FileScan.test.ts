import { createHook } from "node:async_hooks";
import type { Dirent } from "node:fs";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { unpackWorkspaceFileEntries } from "@zcode/shared/workspaceFileEntriesCodec";
import { createFileService } from "../../services/src/file/fileService.js";

const io = vi.hoisted(() => ({
  readdir: vi.fn<(path: string) => Promise<Dirent[]>>(),
  stat: vi.fn<
    (path: string) => Promise<{ isDirectory(): boolean; mtimeMs: number; size: number }>
  >(),
  readFile: vi.fn<(path: string) => Promise<string>>(),
}));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  ...io,
}));

const rootPath = resolve("synthetic-round23-file-scan");
const tree = new Map<string, Dirent[]>();
const links = new Map<string, "directory" | "file" | Error>();

function entry(name: string, type: "directory" | "file" | "symlink" = "file"): Dirent {
  return {
    name,
    isDirectory: () => type === "directory",
    isSymbolicLink: () => type === "symlink",
  } as Dirent;
}

beforeEach(() => {
  vi.resetAllMocks();
  tree.clear();
  links.clear();
  io.readdir.mockImplementation(async (path) => {
    const entries = tree.get(path);
    if (!entries) throw new Error(`Unexpected directory read: ${path}`);
    return entries;
  });
  io.stat.mockImplementation(async (path) => {
    if (path === join(rootPath, ".zcodiumignore"))
      return { mtimeMs: 1, size: 1, isDirectory: () => false };
    const type = links.get(path);
    if (type instanceof Error) throw type;
    if (!type) throw new Error(`Unexpected stat: ${path}`);
    return { mtimeMs: 1, size: 1, isDirectory: () => type === "directory" };
  });
  io.readFile.mockImplementation(async (path) => {
    if (path !== join(rootPath, ".zcodiumignore")) throw new Error(`Unexpected file read: ${path}`);
    return "# synthetic rules\n";
  });
});

async function readIndex(service = createFileService()) {
  const length = await service.listWorkspaceFilesLength({ rootPath });
  return service.listWorkspaceFilesRange({ rootPath, offset: 0, length });
}

async function countScanPromises(files: number) {
  tree.set(
    rootPath,
    Array.from({ length: files }, (_, index) => entry(`file-${String(index).padStart(5, "0")}.ts`)),
  );
  let promises = 0;
  const hook = createHook({
    init(_id, type) {
      if (type === "PROMISE") promises += 1;
    },
  });
  hook.enable();
  try {
    const packed = await readIndex();
    return { packed, promises };
  } finally {
    hook.disable();
  }
}

async function countReaddirPromises(files: number) {
  tree.set(
    rootPath,
    Array.from({ length: files }, (_, index) => entry(`file-${String(index).padStart(5, "0")}.ts`)),
  );
  let promises = 0;
  const hook = createHook({
    init(_id, type) {
      if (type === "PROMISE") promises += 1;
    },
  });
  hook.enable();
  try {
    const entries = await createFileService().readdir({ path: rootPath });
    return { entries, promises };
  } finally {
    hook.disable();
  }
}

describe("public directory entry classification", () => {
  it("bounds ordinary-entry Promise creation while returning every file unchanged", async () => {
    const small = await countReaddirPromises(100);
    const large = await countReaddirPromises(10_000);
    expect(small.entries).toHaveLength(100);
    expect(large.entries).toEqual(
      Array.from({ length: 10_000 }, (_, index) => {
        const name = `file-${String(index).padStart(5, "0")}.ts`;
        return { name, path: join(rootPath, name), type: "file", isSymbolicLink: false };
      }),
    );
    expect(io.stat).not.toHaveBeenCalled();
    expect(io.readdir).toHaveBeenCalledTimes(2);
    expect(
      large.promises - small.promises,
      `Promise counts: small=${small.promises}, large=${large.promises}`,
    ).toBeLessThan(128);
    expect(large.promises).toBeLessThan(128);
  });

  it("starts all visible link stats before awaiting and keeps types after reversed completion", async () => {
    const names = ["linked-a", "linked-b", "linked-denied"];
    const gates = names.map(() =>
      Promise.withResolvers<{ mtimeMs: number; size: number; isDirectory(): boolean }>(),
    );
    tree.set(
      rootPath,
      Object.freeze([
        entry(names[0], "symlink"),
        entry("plain.ts"),
        entry("dir", "directory"),
        entry(names[1], "symlink"),
        entry(names[2], "symlink"),
        entry(".hidden-link", "symlink"),
      ]) as unknown as Dirent[],
    );
    io.stat.mockImplementation(
      (path) => gates[names.indexOf(path.slice(rootPath.length + 1))]!.promise,
    );
    let settled = false;
    const pending = createFileService()
      .readdir({ path: rootPath })
      .then((entries) => {
        settled = true;
        return entries;
      });
    await Promise.resolve();
    expect(io.stat.mock.calls.map(([path]) => path)).toEqual(
      names.map((name) => join(rootPath, name)),
    );
    gates[1]!.resolve({ mtimeMs: 1, size: 0, isDirectory: () => true });
    gates[2]!.reject(Object.assign(new Error("synthetic denied target"), { code: "EACCES" }));
    await Promise.resolve();
    expect(settled).toBe(false);
    gates[0]!.resolve({ mtimeMs: 1, size: 0, isDirectory: () => false });
    expect(
      (await pending).map(({ name, type, isSymbolicLink }) => [name, type, isSymbolicLink]),
    ).toEqual([
      ["dir", "directory", false],
      ["linked-b", "directory", true],
      ["linked-a", "file", true],
      ["linked-denied", "file", true],
      ["plain.ts", "file", false],
    ]);
  });

  it("propagates a directory read failure without starting any target stat", async () => {
    const failure = Object.assign(new Error("synthetic directory failure"), { code: "EIO" });
    io.readdir.mockRejectedValueOnce(failure);
    await expect(createFileService().readdir({ path: rootPath })).rejects.toBe(failure);
    expect(io.stat).not.toHaveBeenCalled();
  });
});

describe("workspace index entry classification", () => {
  it("keeps Promise creation independent of ordinary file count without dropping entries", async () => {
    const small = await countScanPromises(100);
    const large = await countScanPromises(10_000);
    const entries = unpackWorkspaceFileEntries(large.packed, rootPath);
    expect(entries).toHaveLength(10_000);
    expect(
      entries.every(
        (item, index) =>
          item.type === "file" && item.relativePath === `file-${String(index).padStart(5, "0")}.ts`,
      ),
    ).toBe(true);
    expect(io.readdir).toHaveBeenCalledTimes(2);
    expect(io.stat.mock.calls.every(([path]) => path === join(rootPath, ".zcodiumignore"))).toBe(
      true,
    );
    expect(
      large.promises - small.promises,
      `Promise counts: small=${small.promises}, large=${large.promises}`,
    ).toBeLessThan(128);
    expect(large.promises).toBeLessThan(128);
  });

  it("preserves file/directory/link types and never traverses a directory symlink", async () => {
    tree.set(rootPath, [
      entry("z.ts"),
      entry("dir", "directory"),
      entry("linked-dir", "symlink"),
      entry("linked-file", "symlink"),
      entry("broken", "symlink"),
      entry(".hidden"),
      entry(".zcodiumignore"),
    ]);
    tree.set(join(rootPath, "dir"), [entry("nested.ts")]);
    links.set(join(rootPath, "linked-dir"), "directory");
    links.set(join(rootPath, "linked-file"), "file");
    links.set(
      join(rootPath, "broken"),
      Object.assign(new Error("synthetic missing target"), { code: "ENOENT" }),
    );
    const entries = unpackWorkspaceFileEntries(await readIndex(), rootPath);
    expect(entries.map(({ relativePath, type }) => [relativePath, type])).toEqual([
      ["dir", "directory"],
      ["linked-dir", "directory"],
      [".hidden", "file"],
      ["broken", "file"],
      ["dir/nested.ts", "file"],
      ["linked-file", "file"],
      ["z.ts", "file"],
    ]);
    expect(io.readdir.mock.calls.map(([path]) => path).sort()).toEqual(
      [rootPath, join(rootPath, "dir")].sort(),
    );
    expect(io.stat.mock.calls.filter(([path]) => !path.endsWith(".zcodiumignore"))).toHaveLength(3);
  });

  it("retains readdir hidden filtering, link flags and directory-first sorting", async () => {
    tree.set(rootPath, [
      entry("z.ts"),
      entry("dir", "directory"),
      entry("linked", "symlink"),
      entry("broken", "symlink"),
      entry(".hidden"),
    ]);
    links.set(join(rootPath, "linked"), "directory");
    links.set(
      join(rootPath, "broken"),
      Object.assign(new Error("synthetic inaccessible target"), { code: "EACCES" }),
    );
    const service = createFileService();
    const visible = await service.readdir({ path: rootPath });
    expect(visible.map(({ name, type, isSymbolicLink }) => [name, type, isSymbolicLink])).toEqual([
      ["dir", "directory", false],
      ["linked", "directory", true],
      ["broken", "file", true],
      ["z.ts", "file", false],
    ]);
    expect(
      (await service.readdir({ path: rootPath, includeHidden: true })).map(({ name }) => name),
    ).toEqual(["dir", "linked", ".hidden", "broken", "z.ts"]);
  });

  it("still waits for a link target before publishing an index", async () => {
    tree.set(rootPath, [entry("linked", "symlink"), entry("plain.ts")]);
    const pendingStat = Promise.withResolvers<{
      mtimeMs: number;
      size: number;
      isDirectory(): boolean;
    }>();
    const stat = io.stat.getMockImplementation()!;
    io.stat.mockImplementation((path) =>
      path === join(rootPath, "linked") ? pendingStat.promise : stat(path),
    );
    let settled = false;
    const pending = readIndex().then((packed) => {
      settled = true;
      return packed;
    });
    for (let index = 0; index < 32; index += 1) await Promise.resolve();
    expect(io.stat).toHaveBeenCalledWith(join(rootPath, "linked"));
    expect(settled).toBe(false);
    pendingStat.resolve({ mtimeMs: 1, size: 0, isDirectory: () => true });
    expect(
      unpackWorkspaceFileEntries(await pending, rootPath).map(({ name, type }) => [name, type]),
    ).toEqual([
      ["linked", "directory"],
      ["plain.ts", "file"],
    ]);
  });

  it("applies ignore rules and custom include/traverse decisions after classification", async () => {
    io.readFile.mockResolvedValue("ignored/\n*.tmp\n!keep.tmp\n");
    tree.set(rootPath, [
      entry("ignored", "directory"),
      entry("shown-only", "directory"),
      entry("include", "directory"),
      entry("drop.tmp"),
      entry("keep.tmp"),
      entry("filter-out.ts"),
      entry(".zcodiumignore"),
    ]);
    tree.set(join(rootPath, "include"), [entry("child.ts")]);
    const service = createFileService({
      workspaceFileSearchFilter: {
        evaluate: (item) => ({
          include: item.name !== "filter-out.ts",
          traverse: item.name !== "shown-only",
        }),
      },
    });
    expect(
      unpackWorkspaceFileEntries(await readIndex(service), rootPath).map(
        ({ relativePath }) => relativePath,
      ),
    ).toEqual(["include", "shown-only", "include/child.ts", "keep.tmp"]);
    expect(io.readdir.mock.calls.map(([path]) => path)).toEqual([
      rootPath,
      join(rootPath, "include"),
    ]);
  });

  it("drains dynamically discovered directories with at most eight concurrent reads", async () => {
    const directories = Array.from({ length: 24 }, (_, index) => `dir-${index}`);
    tree.set(
      rootPath,
      directories.map((name) => entry(name, "directory")),
    );
    const releases: Array<() => void> = [];
    let active = 0;
    let maximum = 0;
    let completed = 0;
    io.readdir.mockImplementation(async (path) => {
      if (path === rootPath) return tree.get(rootPath)!;
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolveRead) => releases.push(resolveRead));
      active -= 1;
      completed += 1;
      return [entry("child.ts")];
    });
    const pending = readIndex();
    for (let wave = 0; wave < 10 && completed < directories.length; wave += 1) {
      for (let index = 0; index < 128; index += 1) await Promise.resolve();
      releases.splice(0).forEach((release) => release());
    }
    const entries = unpackWorkspaceFileEntries(await pending, rootPath);
    expect(completed).toBe(24);
    expect(maximum).toBe(8);
    expect(entries.filter(({ type }) => type === "directory")).toHaveLength(24);
    expect(entries.filter(({ type }) => type === "file")).toHaveLength(24);
  });

  it.each(["EACCES", "EPERM", "ENOENT"])("skips an unreadable directory with %s", async (code) => {
    tree.set(rootPath, [entry("inaccessible", "directory"), entry("visible.ts")]);
    io.readdir.mockImplementation(async (path) => {
      if (path === rootPath) return tree.get(rootPath)!;
      throw Object.assign(new Error("synthetic directory failure"), { code });
    });
    expect(unpackWorkspaceFileEntries(await readIndex(), rootPath).map(({ name }) => name)).toEqual(
      ["inaccessible", "visible.ts"],
    );
  });

  it("propagates unexpected IO errors and permits a later retry", async () => {
    tree.set(rootPath, [entry("visible.ts")]);
    const failure = Object.assign(new Error("synthetic IO failure"), { code: "EIO" });
    io.readdir.mockRejectedValueOnce(failure);
    const service = createFileService();
    await expect(readIndex(service)).rejects.toBe(failure);
    expect(
      unpackWorkspaceFileEntries(await readIndex(service), rootPath).map(({ name }) => name),
    ).toEqual(["visible.ts"]);
  });
});
