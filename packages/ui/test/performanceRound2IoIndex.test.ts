import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileService } from "../../services/src/file/fileService.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    open: vi.fn(original.open),
    readFile: vi.fn(original.readFile),
    readdir: vi.fn(original.readdir),
  };
});

const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createRoot(withRules = true) {
  const root = await mkdtemp(join(tmpdir(), "zcodium-round2-index-"));
  roots.push(root);
  if (withRules) await writeFile(join(root, ".zcodiumignore"), "hidden.txt\n");
  await writeFile(join(root, "visible.txt"), "visible");
  await writeFile(join(root, "hidden.txt"), "hidden");
  return root;
}

function ruleReads(root: string) {
  return vi.mocked(readFile).mock.calls.filter(([path]) => path === join(root, ".zcodiumignore"));
}

it("checks cached indexes without rereading ignore rules for each query or packed chunk", async () => {
  const rootPath = await createRoot();
  const service = createFileService();
  const params = { rootPath, query: "visible", matchMode: "terms" as const };
  expect((await service.searchWorkspaceFiles(params)).map((file) => file.name)).toEqual([
    "visible.txt",
  ]);
  for (let i = 0; i < 20; i++) await service.searchWorkspaceFiles(params);
  const length = await service.listWorkspaceFilesLength({ rootPath });
  await service.listWorkspaceFilesRange({ rootPath, offset: 0, length });
  expect(ruleReads(rootPath)).toHaveLength(1);
  expect(vi.mocked(readdir).mock.calls.filter(([path]) => path === rootPath)).toHaveLength(1);
});

it("shares same-scope scans while preserving identity isolation and rule invalidation", async () => {
  const rootPath = await createRoot();
  const service = createFileService();
  const params = { rootPath, query: "txt", matchMode: "terms" as const };
  const concurrent = await Promise.all(
    Array.from({ length: 8 }, () => service.searchWorkspaceFiles(params)),
  );
  expect(concurrent.every((files) => files.length === 1)).toBe(true);
  expect(vi.mocked(readdir).mock.calls.filter(([path]) => path === rootPath)).toHaveLength(1);
  await service.searchWorkspaceFiles({ ...params, workspaceIdentity: "remote-owner-a" });
  expect(vi.mocked(readdir).mock.calls.filter(([path]) => path === rootPath)).toHaveLength(2);
  await service.writeWorkspaceFileSearchIgnore({ rootPath, content: "# now all files visible\n" });
  expect((await service.searchWorkspaceFiles(params)).map((file) => file.name)).toEqual([
    "hidden.txt",
    "visible.txt",
  ]);
  expect(vi.mocked(readdir).mock.calls.filter(([path]) => path === rootPath)).toHaveLength(3);
});

it("uses the created rule fingerprint and refreshes only when explicitly requested", async () => {
  const rootPath = await createRoot(false);
  const service = createFileService();
  const params = { rootPath, query: "txt", matchMode: "terms" as const };
  await service.searchWorkspaceFiles(params);
  await service.searchWorkspaceFiles(params);
  expect(vi.mocked(readdir).mock.calls.filter(([path]) => path === rootPath)).toHaveLength(1);
  await service.searchWorkspaceFiles({ ...params, refresh: true });
  expect(vi.mocked(readdir).mock.calls.filter(([path]) => path === rootPath)).toHaveLength(2);
});

it("does not reload rules while the matching scan is in flight", async () => {
  const rootPath = await createRoot();
  const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  vi.mocked(readdir).mockImplementationOnce(async (...args) => {
    const entries = await original.readdir(...args);
    entered.resolve();
    await release.promise;
    return entries;
  });
  const service = createFileService();
  const params = { rootPath, query: "txt", matchMode: "terms" as const };
  const first = service.searchWorkspaceFiles(params);
  await entered.promise;
  const second = service.searchWorkspaceFiles(params);
  release.resolve();
  expect(await second).toEqual(await first);
  expect(ruleReads(rootPath)).toHaveLength(1);
  expect(vi.mocked(readdir).mock.calls.filter(([path]) => path === rootPath)).toHaveLength(1);
});

it("never lets a superseded scan replace the refreshed cache", async () => {
  const rootPath = await createRoot();
  const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  vi.mocked(readdir).mockImplementationOnce(async (...args) => {
    const entries = await original.readdir(...args);
    entered.resolve();
    await release.promise;
    return entries;
  });
  const service = createFileService();
  const params = { rootPath, query: "txt", matchMode: "terms" as const };
  const old = service.searchWorkspaceFiles(params);
  await entered.promise;
  await writeFile(join(rootPath, "new.txt"), "new");
  const refreshed = await service.searchWorkspaceFiles({ ...params, refresh: true });
  expect(refreshed.map((file) => file.name)).toEqual(["new.txt", "visible.txt"]);
  release.resolve();
  expect((await old).map((file) => file.name)).toEqual(["visible.txt"]);
  expect(await service.searchWorkspaceFiles(params)).toEqual(refreshed);
});

it("retries creating missing rules after a temporary write failure", async () => {
  const rootPath = await createRoot(false);
  vi.mocked(open).mockRejectedValueOnce(
    Object.assign(new Error("synthetic read-only root"), { code: "EACCES" }),
  );
  const service = createFileService();
  const params = { rootPath, query: "txt", matchMode: "terms" as const };
  await service.searchWorkspaceFiles(params);
  await expect(stat(join(rootPath, ".zcodiumignore"))).rejects.toMatchObject({ code: "ENOENT" });
  await service.searchWorkspaceFiles(params);
  expect((await stat(join(rootPath, ".zcodiumignore"))).isFile()).toBe(true);
});
