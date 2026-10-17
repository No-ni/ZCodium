import { join, resolve } from "node:path";
import { rm, rmdir } from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createFsStorageCleaner } from "../../services/src/storage/adapters/fsCleaner.js";
import type { StorageCleanCandidate } from "../../services/src/storage/domain/cleanPlan.js";

vi.mock("node:fs/promises", () => ({
  lstat: vi.fn(),
  readdir: vi.fn(),
  rm: vi.fn(),
  rmdir: vi.fn(),
}));

const root = resolve("storage-clean-fixture");
beforeEach(() => {
  vi.mocked(rm).mockReset().mockResolvedValue(undefined);
  vi.mocked(rmdir).mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

function targets(count: number): StorageCleanCandidate[] {
  return Array.from({ length: count }, (_, index) => ({
    relativePath: `file-${index}.log`,
    bytes: index + 1,
    mtimeMs: 0,
  }));
}

async function microtasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function controlledDeletes() {
  const pending: Array<() => void> = [];
  let active = 0;
  let peak = 0;
  vi.mocked(rm).mockImplementation(() => {
    active += 1;
    peak = Math.max(peak, active);
    return new Promise<void>((complete) => {
      pending.push(() => {
        active -= 1;
        complete();
      });
    });
  });
  return {
    pending,
    peak: () => peak,
    async drain() {
      while (pending.length) {
        for (const complete of pending.splice(0)) complete();
        await microtasks();
      }
    },
  };
}

it("consumes a large frozen deletion plan with linear array movement work", async () => {
  const plan = targets(2048);
  for (const target of plan) Object.freeze(target);
  Object.freeze(plan);
  const candidates = new Set(plan);
  const originalShift = Array.prototype.shift;
  let movedReferences = 0;
  Array.prototype.shift = function (this: unknown[]) {
    if (candidates.has(this[0] as StorageCleanCandidate)) {
      movedReferences += this.length - 1;
    }
    return originalShift.call(this);
  };

  let result;
  try {
    result = await createFsStorageCleaner().deleteFiles(root, plan, { keepDirectories: [] });
  } finally {
    Array.prototype.shift = originalShift;
  }
  expect(result).toEqual({ deletedCount: 2048, freedBytes: (2048 * 2049) / 2, failures: [] });
  expect(vi.mocked(rm).mock.calls.map(([path]) => path)).toEqual(
    plan.map((target) => join(root, target.relativePath)),
  );
  expect(rmdir).not.toHaveBeenCalled();
  expect(movedReferences).toBeLessThanOrEqual(plan.length * 2);
});

it("keeps at most eight deletes in flight and admits each snapshot target once", async () => {
  const plan = targets(33);
  const io = controlledDeletes();
  const flight = createFsStorageCleaner().deleteFiles(root, plan, { keepDirectories: [] });
  expect(rm).toHaveBeenCalledTimes(8);
  expect(io.pending).toHaveLength(8);
  io.pending.shift()!();
  await microtasks();
  expect(rm).toHaveBeenCalledTimes(9);
  expect(io.pending).toHaveLength(8);
  await io.drain();
  expect(await flight).toEqual({ deletedCount: 33, freedBytes: (33 * 34) / 2, failures: [] });
  expect(io.peak()).toBe(8);
  expect(vi.mocked(rm).mock.calls.map(([path]) => path)).toEqual(
    plan.map((target) => join(root, target.relativePath)),
  );
});

it("keeps the initial array snapshot when the caller replaces pending candidates", async () => {
  const plan = targets(20);
  const paths = plan.map((target) => join(root, target.relativePath));
  const io = controlledDeletes();
  const flight = createFsStorageCleaner().deleteFiles(root, plan, { keepDirectories: [] });
  plan.splice(0, plan.length, { relativePath: "replacement.log", bytes: 999, mtimeMs: 0 });
  await io.drain();
  expect(await flight).toEqual({ deletedCount: 20, freedBytes: 210, failures: [] });
  expect(vi.mocked(rm).mock.calls.map(([path]) => path)).toEqual(paths);
});

it("isolates failures and outside paths and prunes only after all deletes settle", async () => {
  const plan = [
    { relativePath: "logs/deeper/ok.log", bytes: 3, mtimeMs: 0 },
    { relativePath: "logs/failed.log", bytes: 7, mtimeMs: 0 },
    { relativePath: "../outside.log", bytes: 11, mtimeMs: 0 },
    { relativePath: "cache/another.log", bytes: 13, mtimeMs: 0 },
    { relativePath: "unknown.log", bytes: 17, mtimeMs: 0 },
  ];
  let complete!: () => void;
  const lastDelete = new Promise<void>((done) => (complete = done));
  vi.mocked(rm).mockImplementation(async (path) => {
    if (path === join(root, "logs/failed.log"))
      throw Object.assign(new Error(), { code: "EACCES" });
    if (path === join(root, "unknown.log")) throw new Error("unknown");
    if (path === join(root, "cache/another.log")) await lastDelete;
  });
  vi.mocked(rmdir).mockRejectedValue(Object.assign(new Error(), { code: "ENOTEMPTY" }));
  const flight = createFsStorageCleaner().deleteFiles(root, plan, { keepDirectories: ["logs"] });
  await microtasks();
  expect(rmdir).not.toHaveBeenCalled();
  complete();
  const result = await flight;
  expect(result).toMatchObject({ deletedCount: 2, freedBytes: 16 });
  expect(result.failures).toEqual([
    { path: "../outside.log", code: "EOUTSIDE" },
    { path: "logs/failed.log", code: "EACCES" },
    { path: "unknown.log", code: "UNKNOWN" },
  ]);
  expect(rm).toHaveBeenCalledTimes(4);
  expect(vi.mocked(rm).mock.calls.every(([, options]) => options?.force === false)).toBe(true);
  expect(vi.mocked(rmdir).mock.calls.map(([path]) => path)).toEqual([
    join(root, "logs/deeper"),
    join(root, "cache"),
  ]);
});

it("does no filesystem work for an empty plan", async () => {
  expect(
    await createFsStorageCleaner().deleteFiles(root, [], { keepDirectories: ["logs"] }),
  ).toEqual({ deletedCount: 0, freedBytes: 0, failures: [] });
  expect(rm).not.toHaveBeenCalled();
  expect(rmdir).not.toHaveBeenCalled();
});
