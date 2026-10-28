import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  collectSeaOfficialPluginAssets,
  seaOfficialPluginManifestAssetKey,
} from "../../../apps/zcode-cli/packages/cli/scripts/sea-official-plugin-assets.mjs";
import {
  compiledFixture,
  fileHashes,
  json,
  officePlugins,
  seaFixtureRoot,
  seedOwner,
  temporary,
  write,
} from "./office-distribution.mjs";

const marketplace = "zcode-plugins-official";
const cache = (storage, plugin) => join(storage, "cache", marketplace, plugin.name, plugin.version);
const marker = (root) => join(root, ".zcodium-plugin-seed.json");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function assertCache(sourcePackages, storage) {
  for (const plugin of officePlugins) {
    const source = join(sourcePackages, plugin.directory);
    const root = cache(storage, plugin);
    assert.deepEqual(await fileHashes(join(root, "dist")), await fileHashes(join(source, "dist")));
    assert.equal(
      await readFile(join(root, `skills/${plugin.kind}-viewer/SKILL.md`), "utf8"),
      await readFile(join(source, `skills/${plugin.kind}-viewer/SKILL.md`), "utf8"),
    );
    const manifest = await json(join(root, ".zcodium-plugin/plugin.json"));
    const server = manifest.mcpServers[plugin.name];
    assert.equal(server.command, process.execPath);
    assert.equal(server.args.at(-1), join(root, "dist/server.mjs"));
    assert.equal(server.env.ELECTRON_RUN_AS_NODE, "1");
    assert.ok(Object.values(server.env).includes(`${plugin.name}@${marketplace}`));
    assert.equal((await json(marker(root))).pluginVersion, plugin.version);
  }
}

test(
  "existing filesystem and simulated SEA seed owners publish complete Office units without installation",
  { timeout: 240_000 },
  async (t) => {
    const originalArgv = process.argv[1];
    const originalCwd = process.cwd();
    const getBuiltinModule = process.getBuiltinModule;
    const originalFetch = globalThis.fetch;
    let requests = 0;
    // Windows不能删除当前cwd；样本保留在项目沙箱内不递归清理，恢复钩子只复位进程态。
    t.after(() => {
      process.argv[1] = originalArgv;
      process.chdir(originalCwd);
      process.getBuiltinModule = getBuiltinModule;
      globalThis.fetch = originalFetch;
      assert.equal(requests, 0);
    });
    const fixture = await compiledFixture();
    const source = await temporary("filesystem-source");
    await cp(fixture.packages, join(source, "packages"), {
      recursive: true,
      filter: (path) => !path.endsWith("office-runtime"),
    });
    const owner = await seedOwner(t);
    globalThis.fetch = async () => {
      requests++;
      throw new Error("Office seed fixture must stay offline");
    };
    process.argv[1] = join(source, "zcode.cjs");
    process.chdir(source);
    const storage = await temporary("filesystem-cache");
    const warnings = [];
    const resolve = () =>
      owner.resolveOfficialPluginRoots({
        storageRoot: storage,
        suppressedBuiltins: new Set([`pdf@${marketplace}`]),
        logger: { warn: (_message, fields) => warnings.push(fields) },
      });
    assert.deepEqual(resolve(), []);
    await assertCache(join(source, "packages"), storage);
    assert.equal(warnings.length, 0);
    const before = await Promise.all(
      officePlugins.map((plugin) => stat(marker(cache(storage, plugin)))),
    );
    assert.deepEqual(resolve(), []);
    for (const [index, plugin] of officePlugins.entries()) {
      assert.equal((await stat(marker(cache(storage, plugin)))).mtimeMs, before[index].mtimeMs);
    }
    // The current-cache branch must still use the original source manifest after cache corruption.
    const pdf = officePlugins.find(({ name }) => name === "pdf");
    const pdfCache = cache(storage, pdf);
    const manifestPath = join(pdfCache, ".zcodium-plugin/plugin.json");
    const current = await json(manifestPath);
    current.mcpServers.pdf.args = ["wrong/server.js"];
    await write(manifestPath, JSON.stringify(current));
    resolve();
    assert.equal(
      (await json(manifestPath)).mcpServers.pdf.args.at(-1),
      join(pdfCache, "dist/server.mjs"),
    );
    const seedBefore = (await json(marker(pdfCache))).hash;
    const worker = join(source, "packages/pdf-plugin/dist/ui/pdf-worker.js");
    const workerBytes = await readFile(worker);
    await write(
      worker,
      Buffer.concat([workerBytes, Buffer.from("\n// same-version fixture change\n")]),
    );
    resolve();
    assert.notEqual((await json(marker(pdfCache))).hash, seedBefore);
    assert.equal(
      hash(await readFile(join(pdfCache, "dist/ui/pdf-worker.js"))),
      hash(await readFile(worker)),
    );
    // Missing required cache output re-seeds through the original owner and its lock.
    await rm(join(pdfCache, "dist/ui/assets.json"));
    resolve();
    await assertCache(join(source, "packages"), storage);
    const requiredSource = join(source, "packages/pdf-plugin/dist/THIRD_PARTY_NOTICES.txt");
    const requiredBytes = await readFile(requiredSource);
    const previousMarker = await readFile(marker(pdfCache), "utf8");
    await rm(requiredSource);
    resolve();
    assert.equal(warnings.at(-1).errorCode, "ZCODE_PLUGIN_SEED_INCOMPLETE");
    assert.equal(await readFile(marker(pdfCache), "utf8"), previousMarker);
    assert.equal(
      hash(await readFile(join(pdfCache, "dist/THIRD_PARTY_NOTICES.txt"))),
      hash(requiredBytes),
    );
    await write(requiredSource, requiredBytes);
    // Seed changes immutable cache/catalog only; there must be no installed-plugin inventory.
    await assert.rejects(stat(join(storage, "installed_plugins.json")), { code: "ENOENT" });

    const seaRoot = await seaFixtureRoot(join(source, "packages"));
    const collected = await collectSeaOfficialPluginAssets({
      root: seaRoot,
      requireRuntime: true,
      stagingDirectory: join(fixture.root, "simulated-sea-manifest"),
    });
    const bytes = new Map();
    for (const [key, path] of Object.entries(collected.assets))
      bytes.set(key, await readFile(path));
    assert.ok(bytes.has(seaOfficialPluginManifestAssetKey));
    const sea = {
      isSea: () => true,
      getRawAsset: (key) => {
        const value = bytes.get(key);
        assert.ok(value, key);
        return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
      },
      getAsset: (key, encoding) => {
        const value = bytes.get(key);
        assert.ok(value, key);
        return encoding
          ? value.toString(encoding)
          : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
      },
    };
    // No SEA binary is created or executed: supply only node:sea's asset read port.
    process.getBuiltinModule = (name) => (name === "node:sea" ? sea : getBuiltinModule(name));
    const seaStorage = await temporary("simulated-sea-cache");
    owner.resolveOfficialPluginRoots({ storageRoot: seaStorage });
    await assertCache(join(source, "packages"), seaStorage);
    for (const plugin of officePlugins)
      assert.equal((await json(marker(cache(seaStorage, plugin)))).source, "sea");
    const beforeSea = await Promise.all(
      officePlugins.map((plugin) => readFile(marker(cache(seaStorage, plugin)), "utf8")),
    );
    owner.resolveOfficialPluginRoots({ storageRoot: seaStorage });
    for (const [index, plugin] of officePlugins.entries()) {
      assert.equal(await readFile(marker(cache(seaStorage, plugin)), "utf8"), beforeSea[index]);
    }
    await assert.rejects(stat(join(seaStorage, "installed_plugins.json")), { code: "ENOENT" });
  },
);
