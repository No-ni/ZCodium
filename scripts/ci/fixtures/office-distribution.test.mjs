import assert from "node:assert/strict";
import { access, readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import {
  BUILTIN_PLUGIN_ASSETS,
  BUILTIN_PLUGIN_SEED_PATHS,
} from "../../../packages/shared/src/builtinPluginAssets.ts";
import {
  OFFICE_RUNTIME_OUTPUTS,
  officeRuntimeModule,
} from "../../../apps/zcode-cli/packages/office-runtime/index.ts";
import {
  collectSeaOfficialPluginAssets,
  officialSeaPlugins,
  seaOfficialPluginAssetPrefix,
  seaOfficialPluginManifestAssetKey,
} from "../../../apps/zcode-cli/packages/cli/scripts/sea-official-plugin-assets.mjs";
import { validateBuiltinPluginAssets } from "../../builtin-plugin-assets.mjs";
import {
  compiledFixture,
  completeBuiltinFixture,
  fileHashes,
  json,
  officeAssets,
  officeBuildScript,
  officePlugins,
  prepareHooks,
  repository,
  seaFixtureRoot,
  temporary,
  write,
} from "./office-distribution.mjs";

const frozenOutputs = [
  "dist/server.mjs",
  "dist/ui/assets.json",
  "dist/ui/panel.html",
  "dist/LICENSE",
  "dist/THIRD_PARTY_NOTICES.txt",
];

test("Office contracts, real plugin declarations, shared and SEA assets agree", async () => {
  assert.deepEqual(OFFICE_RUNTIME_OUTPUTS, frozenOutputs);
  for (const plugin of officePlugins) {
    const root = join(repository, "apps/zcode-cli/packages", plugin.directory);
    const pkg = await json(join(root, "package.json"));
    const manifest = await json(join(root, ".zcodium-plugin/plugin.json"));
    const viewer = `skills/${plugin.kind}-viewer/SKILL.md`;
    assert.equal(pkg.version, plugin.version);
    assert.equal(manifest.version, plugin.version);
    assert.equal(manifest.name, plugin.name);
    assert.deepEqual(pkg.office.kinds, [plugin.kind]);
    assert.equal(pkg.scripts.build, `node ${officeBuildScript}`);
    assert.deepEqual(manifest.mcpServers[plugin.name].args, [
      "${CLAUDE_PLUGIN_ROOT}/dist/server.mjs",
    ]);
    assert.match(
      await readFile(join(root, viewer), "utf8"),
      new RegExp(`^name: ${plugin.kind}-viewer$`, "m"),
    );
    await assert.rejects(access(join(root, "tsconfig.json")), { code: "ENOENT" });
    const asset = BUILTIN_PLUGIN_ASSETS.find(({ directory }) => directory === plugin.directory);
    assert.equal(asset.requiresRuntime, true);
    assert.equal(asset.runtimeBuildScript, officeBuildScript);
    for (const path of [...frozenOutputs, viewer, `skills/${plugin.kind}/SKILL.md`]) {
      assert.ok(asset.requiredSeedPaths.includes(path), `${plugin.name}: ${path}`);
    }
    assert.equal(new Set(asset.requiredSeedPaths).size, asset.requiredSeedPaths.length);
    const sea = officialSeaPlugins.find(({ name }) => name === plugin.name);
    assert.ok(sea, `${plugin.name} must be collected for SEA`);
    assert.equal(sea.version, plugin.version);
    assert.equal(sea.packageName, pkg.name);
    assert.equal(sea.requiresRuntime, true);
    assert.deepEqual(sea.requiredSeedPaths, BUILTIN_PLUGIN_SEED_PATHS[plugin.directory]);
    assert.ok(sea.requiredRuntimePaths.includes("dist/server.mjs"));
  }
});

test("only the Office importers and workspace links are needed to match current manifests", async () => {
  const { importers, packages, snapshots } = parse(
    await readFile(join(repository, "pnpm-lock.yaml"), "utf8"),
  );
  for (const directory of [...officePlugins.map((plugin) => plugin.directory), "office-runtime"]) {
    const path = `apps/zcode-cli/packages/${directory}`;
    const pkg = await json(join(repository, path, "package.json"));
    const locked = importers[path].devDependencies;
    assert.deepEqual(Object.keys(locked ?? {}).sort(), Object.keys(pkg.devDependencies).sort());
    for (const [name, specifier] of Object.entries(pkg.devDependencies)) {
      assert.equal(locked[name].specifier, specifier);
      if (specifier === "workspace:*") assert.equal(locked[name].version, "link:../office-runtime");
      else if (/^\d/.test(specifier)) {
        assert.ok(packages[`${name}@${specifier}`]);
        assert.ok(Object.keys(snapshots).some((key) => key.startsWith(`${name}@${specifier}`)));
      }
    }
  }
});

test("office-runtime is managed without baseline or dependency expansion", async () => {
  const policy = parse(await readFile(join(repository, "architecture-policy.yaml"), "utf8"));
  const module = policy.modules.find(({ id }) => id === officeRuntimeModule.id);
  assert.ok(module);
  assert.equal(module.managed, true);
  assert.equal(module.owner, "plugin");
  assert.deepEqual(module.requires, officeRuntimeModule.requires);
  assert.deepEqual(module.roots, ["apps/zcode-cli/packages/office-runtime"]);
  assert.deepEqual(module.layers, { app: "." });
  assert.deepEqual(
    module.publicEntrypoints,
    officeRuntimeModule.publicEntrypoints.map((path) => `${module.roots[0]}/${path}`),
  );
});

test("normal and bootstrap prepare dispatch always build Office once without local tsc", async () => {
  const { desktop, prebuilds } = await prepareHooks();
  const root = await temporary("build-dispatch");
  for (const asset of officeAssets()) {
    for (const path of asset.requiredRuntimePaths)
      await write(join(root, asset.relativePath, path), "old complete runtime");
  }
  for (const bootstrap of [false, true]) {
    for (const [prepare, name] of [
      [desktop.buildOfficialPluginRuntimes, "desktop"],
      [prebuilds.buildRemoteOfficialPluginRuntimes, "prebuilds"],
    ]) {
      const calls = [];
      await prepare({
        root,
        plugins: officeAssets(),
        bootstrap,
        run: (command, args, options) => calls.push({ command, args, cwd: options.cwd }),
      });
      assert.equal(
        calls.length,
        officePlugins.length,
        `${name}/${bootstrap}: rebuild even with complete old dist`,
      );
      for (const [index, call] of calls.entries()) {
        assert.equal(call.command, process.execPath);
        assert.deepEqual(call.args, [officeBuildScript]);
        assert.equal(call.cwd, resolve(root, officeAssets()[index].relativePath));
      }
    }
  }
});

test("ordinary Desktop dev declares all four Office runtimes and uses the shared build", async () => {
  const path = join(repository, "scripts/build-desktop-agent-cli.mjs");
  assert.match(await readFile(path, "utf8"), /if \(entryHref === import\.meta\.url\)/);
  const { pathToFileURL } = await import("node:url");
  const dev = await import(pathToFileURL(path).href);
  const root = await temporary("dev-dispatch");
  for (const asset of officeAssets()) {
    for (const path of asset.requiredRuntimePaths)
      await write(join(root, asset.relativePath, path), "complete fixture runtime");
    assert.ok(
      dev.requiredDevPluginRuntimeBuilds.some(
        ({ packageName }) => packageName === asset.packageName,
      ),
    );
  }
  const calls = [];
  await dev.buildOfficeDevPluginRuntimes({
    root,
    run: (command, args, options) => calls.push({ command, args, cwd: options.cwd }),
  });
  assert.equal(calls.length, 4);
  for (const call of calls) {
    assert.equal(call.command, process.execPath);
    assert.deepEqual(call.args, [officeBuildScript]);
  }
  const turbo = await json(join(repository, "apps/zcode-cli/turbo.json"));
  for (const asset of officeAssets()) {
    assert.ok(turbo.tasks["build:desktop-agent"].dependsOn.includes(`${asset.packageName}#build`));
    assert.equal(turbo.tasks[`${asset.packageName}#build`].cache, false);
  }
  assert.deepEqual(turbo.tasks["@zcode/office-runtime#build"].outputs, []);
});

test(
  "actual four-format builds survive recursive staging and SEA collection byte-for-byte",
  { timeout: 240_000 },
  async () => {
    const fixture = await compiledFixture();
    const { desktop, prebuilds } = await prepareHooks();
    await completeBuiltinFixture(fixture.packages);
    await validateBuiltinPluginAssets(fixture.packages);
    for (const plugin of officePlugins) {
      const root = join(fixture.packages, plugin.directory);
      const hashes = await fileHashes(join(root, "dist"));
      const assets = await json(join(root, "dist/ui/assets.json"));
      assert.ok(assets.scripts.length);
      for (const name of assets.scripts) assert.ok(hashes[`ui/${name}`]);
      assert.ok(hashes["ui/panel.css"]);
      assert.match(
        await readFile(join(root, "dist/LICENSE"), "utf8"),
        /MIT License[\s\S]*Permission is hereby granted/,
      );
      assert.match(
        await readFile(join(root, "dist/THIRD_PARTY_NOTICES.txt"), "utf8"),
        /ISC License[\s\S]*Permission to use/,
      );
      if (plugin.kind === "xlsx") {
        for (const name of ["ui/xlsx-worker.js", "ui/sheets.wasm"]) assert.ok(hashes[name]);
      }
      if (plugin.kind === "pdf") {
        for (const name of ["ui/pdf-worker.js", "ui/cjk-fallback.json"]) assert.ok(hashes[name]);
        for (const directory of [
          "ui/pdfjs/cmaps/",
          "ui/pdfjs/standard_fonts/",
          "ui/pdfjs/wasm/",
          "ui/fonts/",
        ]) {
          assert.ok(Object.keys(hashes).some((name) => name.startsWith(directory)));
        }
        const fonts = await json(join(root, "dist/ui/cjk-fallback.json"));
        for (const { file } of fonts.faces) assert.ok(hashes[`ui/${file}`]);
        assert.ok(
          Object.keys(hashes).some(
            (name) => name.startsWith("ui/pdfjs/") && /\/LICENSE/.test(name),
          ),
        );
        assert.match(
          await readFile(join(root, "dist/THIRD_PARTY_NOTICES.txt"), "utf8"),
          /SIL OPEN FONT LICENSE/,
        );
      }
    }
    for (const [stage, name] of [
      [desktop.stageOfficialPlugins, "desktop"],
      [prebuilds.stageRemoteOfficialPlugins, "prebuilds"],
    ]) {
      const glmDir = join(fixture.root, `${name}-staged`);
      // Old stage directories must not retain removed resources on a repeated prepare.
      for (const plugin of officePlugins)
        await write(join(glmDir, "packages", plugin.directory, "dist/ui/stale-worker.js"), "stale");
      await stage(glmDir, { root: fixture.root, plugins: officeAssets() });
      for (const plugin of officePlugins) {
        const source = join(fixture.packages, plugin.directory);
        const target = join(glmDir, "packages", plugin.directory);
        assert.deepEqual(
          await fileHashes(join(target, "dist")),
          await fileHashes(join(source, "dist")),
        );
        assert.equal(
          await readFile(join(target, `skills/${plugin.kind}-viewer/SKILL.md`), "utf8"),
          await readFile(join(source, `skills/${plugin.kind}-viewer/SKILL.md`), "utf8"),
        );
      }
    }
    const seaRoot = await seaFixtureRoot(fixture.packages);
    const collected = await collectSeaOfficialPluginAssets({
      root: seaRoot,
      requireRuntime: true,
      stagingDirectory: join(fixture.root, "sea-manifest"),
    });
    for (const plugin of officePlugins) {
      const entry = collected.manifest.plugins.find(({ name }) => name === plugin.name);
      assert.ok(entry);
      const expected = await fileHashes(join(fixture.packages, plugin.directory, "dist"));
      const actual = Object.fromEntries(
        entry.files
          .filter(({ path }) => path.startsWith("dist/"))
          .map(({ path, sha256 }) => [path.slice(5), sha256]),
      );
      assert.deepEqual(actual, expected);
      for (const file of entry.files) {
        assert.ok(
          collected.assets[
            `${seaOfficialPluginAssetPrefix}${entry.marketplace}/${entry.name}/${entry.version}/${file.path}`
          ],
        );
      }
    }
    const firstHash = collected.manifest.hash;
    const worker = join(seaRoot, "packages/pdf-plugin/dist/ui/pdf-worker.js");
    const bytes = await readFile(worker);
    await write(worker, Buffer.concat([bytes, Buffer.from("\n// same-version source update\n")]));
    const changed = await collectSeaOfficialPluginAssets({
      root: seaRoot,
      requireRuntime: true,
      stagingDirectory: join(fixture.root, "sea-manifest"),
    });
    assert.notEqual(changed.manifest.hash, firstHash);
    const manifestFile = join(fixture.root, "sea-manifest/official-plugins-manifest.json");
    assert.equal(changed.assets[seaOfficialPluginManifestAssetKey], manifestFile);
    await write(worker, bytes);
    for (const plugin of officePlugins) {
      for (const path of [...frozenOutputs, `skills/${plugin.kind}-viewer/SKILL.md`]) {
        const source = join(fixture.packages, plugin.directory, path);
        const data = await readFile(source);
        await rm(source);
        await assert.rejects(
          validateBuiltinPluginAssets(fixture.packages),
          /Missing builtin plugin asset/,
        );
        await write(source, data);
        const seaSource = join(seaRoot, "packages", plugin.directory, path);
        const seaData = await readFile(seaSource);
        await rm(seaSource);
        await assert.rejects(
          collectSeaOfficialPluginAssets({
            root: seaRoot,
            requireRuntime: true,
            stagingDirectory: join(fixture.root, "sea-manifest"),
          }),
          /Missing .*required seed asset/,
        );
        await assert.rejects(stat(manifestFile), { code: "ENOENT" });
        await write(seaSource, seaData);
      }
    }
  },
);
