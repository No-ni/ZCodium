import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fs = vi.hoisted(() => ({
  lstat: vi.fn(),
  stat: vi.fn(),
  readdir: vi.fn(),
  readFile: vi.fn(),
  realpath: vi.fn(),
  existingRoots: new Set<string>(),
}));

vi.mock("node:fs", () => ({ existsSync: (path: string) => fs.existingRoots.has(path) }));
vi.mock("node:fs/promises", () => fs);

import { createSkillSyncService } from "../../services/src/skill-sync/skillSyncService.js";
import { join } from "node:path";

const MAX_SCAN_IO = 8;
const skillRoot = join("C:/fixture", ".zcodium", "skills");
const legacyRoot = join("C:/fixture", ".agents", "skills");

function file(size: number) {
  return { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, size };
}

function directory() {
  return { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, size: 0 };
}

function symlink() {
  return { isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true, size: 0 };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

function configureRoots(
  entries: Map<string, Array<{ name: string; isDirectory(): boolean; isSymbolicLink(): boolean }>>,
) {
  fs.existingRoots.add(skillRoot);
  fs.existingRoots.add(legacyRoot);
  fs.readdir.mockImplementation(async (path: string) => {
    const value = entries.get(path);
    if (!value) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return value;
  });
  fs.readFile.mockImplementation(async (path: string) => {
    if (path.endsWith("SKILL.md")) return "---\nname: fixture\n---\n";
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  });
  fs.realpath.mockImplementation(async (path: string) => path);
  fs.lstat.mockImplementation(async (path: string) => {
    if (entries.has(path)) return directory();
    return file(Number(path.match(/file-(\d+)/)?.[1] ?? 1));
  });
  fs.stat.mockImplementation(async () => directory());
}

describe("skill sync candidate size scan IO bound", () => {
  beforeEach(() => {
    vi.stubEnv("HOME", "C:/fixture");
    vi.stubEnv("USERPROFILE", "C:/fixture");
    fs.existingRoots.clear();
    vi.stubEnv("ZCODE_USER_DATA_DIR_NAME", ".zcodium");
    fs.lstat.mockReset();
    fs.stat.mockReset();
    fs.readdir.mockReset();
    fs.readFile.mockReset();
    fs.realpath.mockReset();
  });

  afterEach(() => vi.unstubAllEnvs());

  it("limits total in-flight metadata IO across nested directories and multiple candidates", async () => {
    const tree = new Map<
      string,
      Array<{ name: string; isDirectory(): boolean; isSymbolicLink(): boolean }>
    >([
      [
        skillRoot,
        ["alpha", "beta"].map((name) => ({
          name,
          isDirectory: () => true,
          isSymbolicLink: () => false,
        })),
      ],
      [legacyRoot, []],
    ]);
    for (const candidate of ["alpha", "beta"]) {
      const root = join(skillRoot, candidate);
      const nested = join(root, "nested");
      tree.set(root, [
        { name: "SKILL.md", isDirectory: () => false, isSymbolicLink: () => false },
        { name: "nested", isDirectory: () => true, isSymbolicLink: () => false },
        ...Array.from({ length: 520 }, (_, index) => ({
          name: `file-${index + 1}`,
          isDirectory: () => false,
          isSymbolicLink: () => false,
        })),
      ]);
      tree.set(
        nested,
        Array.from({ length: 520 }, (_, index) => ({
          name: `file-${index + 1001}`,
          isDirectory: () => false,
          isSymbolicLink: () => false,
        })),
      );
    }
    configureRoots(tree);

    const gates: Array<{
      path: string;
      gate: ReturnType<typeof deferred<ReturnType<typeof file>>>;
    }> = [];
    let active = 0;
    let peak = 0;
    fs.lstat.mockImplementation((path: string) => {
      active += 1;
      peak = Math.max(peak, active);
      const gate = deferred<ReturnType<typeof file>>();
      gates.push({ path, gate });
      return gate.promise.finally(() => active--);
    });

    const flight = createSkillSyncService().listLocalUserSkillCandidates();
    let done = false;
    void flight.finally(() => (done = true)).catch(() => {});
    for (let cycle = 0; cycle < 1000 && !done; cycle += 1) {
      await flushMicrotasks();
      for (const { path, gate } of gates.splice(0)) {
        gate.resolve(
          tree.has(path) ? directory() : file(Number(path.match(/file-(\d+)/)?.[1] ?? 1)),
        );
      }
    }
    await flushMicrotasks();
    for (const { path, gate } of gates.splice(0)) {
      gate.resolve(tree.has(path) ? directory() : file(Number(path.match(/file-(\d+)/)?.[1] ?? 1)));
    }
    const result = await flight;

    expect(peak).toBeLessThanOrEqual(MAX_SCAN_IO);
    expect(result.candidates.map((candidate) => candidate.directoryName)).toEqual([
      "alpha",
      "beta",
    ]);
    expect(result.candidates.map((candidate) => candidate.sizeBytes)).toEqual([790921, 790921]);
  });

  it("preserves symlink deduplication, broken links and directory error propagation", async () => {
    const alpha = join(skillRoot, "alpha");
    const hiddenDirectory = join(alpha, ".private-data");
    const tree = new Map<
      string,
      Array<{ name: string; isDirectory(): boolean; isSymbolicLink(): boolean }>
    >([
      [skillRoot, [{ name: "alpha", isDirectory: () => true, isSymbolicLink: () => false }]],
      [legacyRoot, []],
      [
        alpha,
        [
          { name: "SKILL.md", isDirectory: () => false, isSymbolicLink: () => false },
          { name: "first-link", isDirectory: () => false, isSymbolicLink: () => true },
          { name: "second-link", isDirectory: () => false, isSymbolicLink: () => true },
          { name: "broken-link", isDirectory: () => false, isSymbolicLink: () => true },
          { name: "cycle-link", isDirectory: () => false, isSymbolicLink: () => true },
          { name: ".private-data", isDirectory: () => true, isSymbolicLink: () => false },
        ],
      ],
      [
        join(alpha, "target"),
        [{ name: "file-9", isDirectory: () => false, isSymbolicLink: () => false }],
      ],
      [hiddenDirectory, []],
    ]);
    configureRoots(tree);
    fs.lstat.mockImplementation(async (path: string) => {
      if (tree.has(path)) return directory();
      if (
        ["first-link", "second-link", "broken-link", "cycle-link"].some(
          (name) => path === join(alpha, name),
        )
      )
        return symlink();
      if (path === join(alpha, "target")) return directory();
      if (path.endsWith("file-9")) return file(9);
      return file(1);
    });
    fs.stat.mockImplementation(async (path: string) => {
      if (path.endsWith("broken-link"))
        throw Object.assign(new Error("broken"), { code: "ENOENT" });
      return directory();
    });
    fs.realpath.mockImplementation(async (path: string) =>
      path.endsWith("first-link") || path.endsWith("second-link")
        ? join(alpha, "target")
        : path.endsWith("cycle-link")
          ? alpha
          : path,
    );
    fs.readdir.mockImplementation(async (path: string) => {
      if (path === join(alpha, "first-link") || path === join(alpha, "second-link"))
        return tree.get(join(alpha, "target"))!;
      return tree.get(path) ?? [];
    });
    const result = await createSkillSyncService().listLocalUserSkillCandidates();
    expect(result.candidates[0]?.sizeBytes).toBe(10);
    expect(fs.lstat.mock.calls.filter(([path]) => path.endsWith("file-9"))).toHaveLength(1);

    const readdir = fs.readdir.getMockImplementation()!;
    fs.readdir.mockImplementation(async (path: string, options: unknown) => {
      if (path === hiddenDirectory) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      return await readdir(path, options);
    });
    await expect(createSkillSyncService().listLocalUserSkillCandidates()).rejects.toMatchObject({
      code: "EACCES",
    });
  });

  it("waits for in-flight metadata IO to settle before propagating a scan failure", async () => {
    const alpha = join(skillRoot, "alpha");
    const tree = new Map<
      string,
      Array<{ name: string; isDirectory(): boolean; isSymbolicLink(): boolean }>
    >([
      [skillRoot, [{ name: "alpha", isDirectory: () => true, isSymbolicLink: () => false }]],
      [legacyRoot, []],
      [
        alpha,
        [
          { name: "SKILL.md", isDirectory: () => false, isSymbolicLink: () => false },
          ...Array.from({ length: 16 }, (_, index) => ({
            name: `file-${index + 1}`,
            isDirectory: () => false,
            isSymbolicLink: () => false,
          })),
        ],
      ],
    ]);
    configureRoots(tree);
    const gate = deferred<ReturnType<typeof file>>();
    const failure = Object.assign(new Error("EACCES"), { code: "EACCES" });
    let gateStarted = false;
    fs.lstat.mockImplementation((path: string) => {
      if (path === alpha) return Promise.resolve(directory());
      if (path.endsWith("file-1")) return Promise.reject(failure);
      if (path.endsWith("file-2")) {
        gateStarted = true;
        return gate.promise;
      }
      return Promise.resolve(file(Number(path.match(/file-(\d+)/)?.[1] ?? 1)));
    });

    const flight = createSkillSyncService().listLocalUserSkillCandidates();
    let settled = false;
    void flight.finally(() => (settled = true)).catch(() => {});
    await flushMicrotasks();
    expect(gateStarted).toBe(true);
    expect(settled).toBe(false);
    expect(fs.lstat.mock.calls.some(([path]) => path.endsWith("file-9"))).toBe(false);

    gate.resolve(file(2));
    await expect(flight).rejects.toBe(failure);
    expect(settled).toBe(true);
  });

  it("falls back to the link path when realpath fails", async () => {
    const alpha = join(skillRoot, "alpha");
    const linkPath = join(alpha, "fallback-link");
    const tree = new Map<
      string,
      Array<{ name: string; isDirectory(): boolean; isSymbolicLink(): boolean }>
    >([
      [skillRoot, [{ name: "alpha", isDirectory: () => true, isSymbolicLink: () => false }]],
      [legacyRoot, []],
      [
        alpha,
        [
          { name: "SKILL.md", isDirectory: () => false, isSymbolicLink: () => false },
          { name: "fallback-link", isDirectory: () => false, isSymbolicLink: () => true },
        ],
      ],
    ]);
    configureRoots(tree);
    fs.lstat.mockImplementation(async (path: string) => {
      if (path === alpha) return directory();
      if (path === linkPath) return symlink();
      return file(path.endsWith("SKILL.md") ? 1 : 4);
    });
    fs.stat.mockImplementation(async () => directory());
    fs.realpath.mockImplementation(async (path: string) => {
      if (path === linkPath) throw new Error("realpath unavailable");
      return path;
    });
    fs.readdir.mockImplementation(async (path: string) => {
      if (path === linkPath)
        return [{ name: "payload", isDirectory: () => false, isSymbolicLink: () => false }];
      return tree.get(path) ?? [];
    });

    const result = await createSkillSyncService().listLocalUserSkillCandidates();
    expect(result.candidates[0]?.sizeBytes).toBe(5);
    expect(fs.readdir).toHaveBeenCalledWith(linkPath, { withFileTypes: true });
  });
});
