import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { collectRuntimeModuleClosureEntries } from "../../packages/desktop/scripts/runtime-dependency-closure.mjs";
import { createProjectTestSandbox } from "./project-test-sandbox.mjs";

async function fixture(label, packages = {}) {
  const sandbox = await createProjectTestSandbox(label);
  for (const [name, metadata] of Object.entries(packages)) {
    const directory = join(sandbox.root, "node_modules", name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "package.json"), JSON.stringify({ name, ...metadata }));
  }
  return sandbox.root;
}

test("missing required runtime roots fail instead of disappearing from packaging", async () => {
  const root = await fixture("runtime-missing-root");
  assert.throws(
    () => collectRuntimeModuleClosureEntries(["missing-runtime"], [root]),
    /Required runtime dependency not found: missing-runtime/,
  );
});

test("missing transitive runtime dependencies fail before afterPack injection", async () => {
  const root = await fixture("runtime-missing-child", {
    parent: { dependencies: { "missing-child": "1.0.0" } },
  });
  assert.throws(
    () => collectRuntimeModuleClosureEntries(["parent"], [root]),
    /Required runtime dependency not found: missing-child/,
  );
});

test("absent optional dependencies remain optional and installed dependencies are retained", async () => {
  const root = await fixture("runtime-optional-child", {
    parent: {
      dependencies: { child: "1.0.0" },
      optionalDependencies: { "absent-platform-package": "1.0.0" },
    },
    child: {},
  });
  const entries = collectRuntimeModuleClosureEntries(["parent"], [root]);
  assert.deepEqual(
    entries.map(({ moduleName }) => moduleName),
    ["parent", "child"],
  );
  assert.ok(entries.every(({ sourceModulePath }) => sourceModulePath));
});

test("afterPack and final bundle validation both reject a missing required runtime", async () => {
  const root = await fixture("runtime-packaging-entrypoints");
  for (const [file, name, endMarker, parameters] of [
    [
      "packages/desktop/electron-builder.config.js",
      "resolveMissingRuntimeModules",
      "async function finalizePackagedAppAsar",
      ["app.asar"],
    ],
    [
      "packages/desktop/scripts/bundle.mjs",
      "verifyPackagedRuntimeDependencies",
      "async function main",
      ["win", "x64"],
    ],
  ]) {
    const source = await readFile(new URL(`../../${file}`, import.meta.url), "utf8");
    const start = source.indexOf(`function ${name}(`);
    const end = source.indexOf(endMarker, start);
    assert.ok(start >= 0 && end > start);
    const execute = runInNewContext(`${source.slice(start, end)}; ${name}`, {
      collectRuntimeModuleClosureEntries,
      resolve,
      REQUIRED_ASAR_RUNTIME_MODULES: ["missing-runtime"],
      requiredRuntimeModules: ["missing-runtime"],
      runtimeModuleLookupRoots: [root],
      runAsarCommandAndReadStdout: () => "/node_modules/present-runtime/index.js",
      normalizeAsarEntry: (entry) => entry,
      resolveAppAsarPath: () => "app.asar",
      existsSync: () => true,
      parseAsarListWithPackState: () => [],
      runAndReadStdout: () => "",
      findDesktopNativePackageViolations: () => [],
      process: { execPath: "node" },
      asarCliPath: "asar.js",
      console: { warn() {} },
    });
    assert.throws(
      () => execute(...parameters),
      /Required runtime dependency not found: missing-runtime/,
      file,
    );
  }
});
