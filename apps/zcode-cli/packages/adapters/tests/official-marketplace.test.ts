import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as asyncFs from "node:fs/promises";
import * as pluginFiles from "../src/plugins/helpers.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeBundledOfficialMarketplacePartition, updateMarketplace } from "../src/plugins/index.js";
import { loadMarketplaceManifestSync } from "../src/plugins/marketplace.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

describe("ZCodium bundled marketplace authority", () => {
  const roots: string[] = [];
  async function makeStorageRoot() {
    const root = await mkdtemp(join(tmpdir(), "zcodium-bundled-marketplace-"));
    roots.push(root);
    return root;
  }
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });

  it("retries transient rename contention and preserves the previous file on persistent failure", async () => {
    const root = await makeStorageRoot();
    const path = join(root, "manifest.json");
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    await writeFile(path, "old");
    const rename = vi
      .spyOn(asyncFs, "rename")
      .mockClear()
      .mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "EPERM" }));
    rename.mockImplementationOnce(actual.rename);
    await pluginFiles.writePluginTextIfChanged(path, "new");
    expect(rename).toHaveBeenCalledTimes(2);
    expect(await readFile(path, "utf8")).toBe("new");
    rename.mockRejectedValue(Object.assign(new Error("busy"), { code: "EACCES" }));
    await expect(pluginFiles.writePluginTextIfChanged(path, "incomplete")).rejects.toMatchObject({
      code: "EACCES",
    });
    expect(await readFile(path, "utf8")).toBe("new");
    expect(await actual.readdir(root)).toEqual(["manifest.json"]);
  });

  it("reseeding uses only the current bundled partition and excludes stale CDN cache", async () => {
    const storageRoot = await makeStorageRoot();
    const directory = join(storageRoot, "marketplaces", "zcode-plugins-official");
    await mkdir(directory, { recursive: true });
    const historical = JSON.stringify({ name: "zcode-plugins-official", plugins: [{ name: "remote" }] });
    await writeFile(join(directory, "cdn-marketplace.json"), historical);
    await writeFile(join(directory, "marketplace.json"), historical);
    await writeBundledOfficialMarketplacePartition({ storageRoot, manifest: { name: "zcode-plugins-official", plugins: [{ name: "old-bundled" }] } });
    await writeBundledOfficialMarketplacePartition({ storageRoot, manifest: { name: "zcode-plugins-official", plugins: [{ name: "current-bundled" }] } });
    // 当前随包 seed 是唯一权威，历史合并/CDN 缓存不能恢复退役插件。
    expect(loadMarketplaceManifestSync(storageRoot, "zcode-plugins-official")?.plugins.map(plugin => plugin.name)).toEqual(["current-bundled"]);
    expect(await readFile(join(directory, "cdn-marketplace.json"), "utf8")).toBe(historical);
  });

  it("concurrent bundled writes publish a complete snapshot and identical seed does not rewrite", async () => {
    const storageRoot = await makeStorageRoot();
    const manifests = ["first", "second"].map(name => ({ name: "zcode-plugins-official", plugins: [{ name }] }));
    await Promise.all(manifests.map(manifest => writeBundledOfficialMarketplacePartition({ storageRoot, manifest })));
    const path = join(storageRoot, "marketplaces", "zcode-plugins-official", "bundled-marketplace.json");
    const content = await readFile(path, "utf8");
    const published = JSON.parse(content);
    expect(manifests).toContainEqual(published.manifest);
    const before = await stat(path);
    await writeBundledOfficialMarketplacePartition({ storageRoot, manifest: published.manifest });
    expect(await readFile(path, "utf8")).toBe(content);
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
  });

  it("rejects an invalid bundled identity", async () => {
    const storageRoot = await makeStorageRoot();
    await expect(writeBundledOfficialMarketplacePartition({ storageRoot, manifest: { name: "zcode-plugins", plugins: [] } })).rejects.toThrow("Official marketplace manifest must be named zcode-plugins-official");
  });

  it("updating the bundled identity never calls a historical registered source", async () => {
    const storageRoot = await makeStorageRoot();
    await writeBundledOfficialMarketplacePartition({ storageRoot, manifest: { name: "zcode-plugins-official", plugins: [{ name: "bundled" }] } });
    await writeFile(join(storageRoot, "known_marketplaces.json"), JSON.stringify({ version: 1, marketplaces: [{ id: "zcode-plugins-official", source: { source: "url", url: "https://market.example.test/catalog" }, addedAt: "", pluginCount: 99 }] }));
    const fetch = vi.fn(() => { throw new Error("Historical source must stay unused"); });
    vi.stubGlobal("fetch", fetch);
    try {
      const [updated] = await updateMarketplace({ storageRoot, marketplace: "zcode-plugins-official" });
      expect(updated).toMatchObject({ id: "zcode-plugins-official", pluginCount: 1, source: { source: "bundled" } });
      expect(fetch).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
});
