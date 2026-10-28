import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";
import { assertProjectPath, createProjectTestFixture } from "../project-test-sandbox.mjs";
import {
  BUILTIN_PLUGIN_ASSETS,
  cuaRuntimeRequiredPaths,
} from "../../../packages/shared/src/builtinPluginAssets.ts";
import { officialSeaPlugins } from "../../../apps/zcode-cli/packages/cli/scripts/sea-official-plugin-assets.mjs";

export const repository = resolve(import.meta.dirname, "../../..");
export const officeBuildScript = "../office-runtime/scripts/build.mjs";
export const officePlugins = [
  ["documents", "docx", "0.1.9"],
  ["spreadsheets", "xlsx", "0.1.9"],
  ["presentations", "pptx", "0.1.9"],
  ["pdf", "pdf", "0.2.1"],
].map(([name, kind, version]) => ({ name, kind, version, directory: `${name}-plugin` }));
export const officeAssets = () =>
  BUILTIN_PLUGIN_ASSETS.filter(({ directory }) =>
    officePlugins.some((plugin) => plugin.directory === directory),
  );
export const json = async (path) => JSON.parse(await readFile(path, "utf8"));
export const write = async (path, value) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value);
};

// 项目内 fresh 合成样本：落在 PROJECT_TEST_SANDBOX_ROOT/fixtures 下，不写系统临时目录，不做整根递归清理。
export async function temporary(label) {
  return createProjectTestFixture(`office-${label}`);
}

export function execute(command, args, options = {}) {
  return new Promise((done, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    const chunks = [];
    child.stdout.on("data", (bytes) => chunks.push(bytes));
    child.stderr.on("data", (bytes) => chunks.push(bytes));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      const output = Buffer.concat(chunks).toString("utf8");
      if (code === 0) done(output);
      else reject(new Error(`Office fixture command failed (${code ?? signal}): ${output}`));
    });
  });
}

// 沙箱 NODE_OPTIONS 下 fs.symlink 需完整（非通配）授权而被拒时，回退平台原生创建（异步）：
// 先 assertProjectPath 逐级校验 linkPath 在项目内且无重解析点，只写链接本身；target 只读。
async function readOnlyLink(target, linkPath) {
  await assertProjectPath(linkPath);
  try {
    await symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
    return;
  } catch (error) {
    if (error?.code !== "ERR_ACCESS_DENIED" && error?.code !== "EPERM" && error?.code !== "ENOSYS")
      throw error;
  }
  const windows = process.platform === "win32";
  await execute(
    windows ? (process.env.ComSpec ?? "cmd.exe") : "ln",
    windows ? ["/d", "/c", "mklink", "/J", linkPath, target] : ["-s", target, linkPath],
    { env: process.env },
  );
}

/** Only fixture trees are writable; the runtime junction resolves the actual checked-out build. */
export async function compiledFixture() {
  const root = await temporary("distribution");
  const packages = join(root, "apps/zcode-cli/packages");
  await mkdir(packages, { recursive: true });
  await readOnlyLink(
    join(repository, "apps/zcode-cli/packages/office-runtime"),
    join(packages, "office-runtime"),
  );
  for (const plugin of officePlugins) {
    const source = join(repository, "apps/zcode-cli/packages", plugin.directory);
    const target = join(packages, plugin.directory);
    await cp(source, target, {
      recursive: true,
      filter: (path) =>
        !relative(source, path)
          .split(sep)
          .some((name) => ["dist", "node_modules", ".venv", "__pycache__"].includes(name)),
    });
    // Execute the registered relative build from the plugin cwd, not a mock resource generator.
    await execute(process.execPath, [officeBuildScript], { cwd: target });
  }
  return { root, packages };
}

export async function fileHashes(root) {
  const hashes = {};
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const name = relative(root, path).split(sep).join("/");
        hashes[name] = createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
      }
    }
  }
  await walk(root);
  return Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b)));
}

export async function completeBuiltinFixture(packages) {
  for (const plugin of BUILTIN_PLUGIN_ASSETS) {
    if (officePlugins.some(({ directory }) => directory === plugin.directory)) continue;
    for (const path of [".zcodium-plugin/plugin.json", ...plugin.requiredSeedPaths]) {
      await write(join(packages, plugin.directory, path), "synthetic non-Office asset");
    }
  }
  for (const path of cuaRuntimeRequiredPaths(process.platform, process.arch)) {
    await write(join(packages, "node-repl-host", path), "synthetic unused CUA fixture");
  }
}

export async function seaFixtureRoot(sourcePackages) {
  const root = await temporary("sea-assets");
  for (const plugin of officialSeaPlugins) {
    const target = join(root, plugin.rootPath);
    const office = officePlugins.find(({ name }) => name === plugin.name);
    if (office) {
      await cp(join(sourcePackages, office.directory), target, { recursive: true });
      continue;
    }
    await write(join(target, ".zcodium-plugin/plugin.json"), JSON.stringify({ name: plugin.name }));
    for (const path of [
      ...(plugin.requiredSeedPaths ?? []),
      ...(plugin.requiredRuntimePaths ?? []),
    ]) {
      await write(join(target, path), "synthetic non-Office SEA asset");
    }
  }
  return root;
}

export async function prepareHooks() {
  const desktopPath = join(repository, "packages/desktop/scripts/prepare-agent-node-bundle.mjs");
  const prebuildsPath = join(repository, "scripts/prepare-prebuilds.mjs");
  // 这两个入口的默认执行会准备产品/远端资源；先确认导入保护，再加载 Office 专用接缝。
  for (const path of [desktopPath, prebuildsPath]) {
    assert.ok(
      /if \(entryHref === import\.meta\.url\)/.test(await readFile(path, "utf8")),
      "Office prepare fixtures require import-safe entry points",
    );
  }
  const desktop = await import(pathToFileURL(desktopPath).href);
  const prebuilds = await import(pathToFileURL(prebuildsPath).href);
  return { desktop, prebuilds };
}

/** Load the existing seed owner without compiling a CLI/SEA product or native runtime. */
export async function seedOwner(t) {
  const owner = await tsImport(
    "../../../apps/zcode-cli/packages/bootstrap/src/app/bundled-plugins.ts",
    import.meta.url,
  );
  const { OFFICIAL_PLUGIN_DEFINITIONS } = await tsImport(
    "../../../apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts",
    import.meta.url,
  );
  const original = [...OFFICIAL_PLUGIN_DEFINITIONS];
  const candidates = new Map(original.map((definition) => [definition, definition.rootCandidates]));
  t.after(() => {
    for (const [definition, roots] of candidates) definition.rootCandidates = roots;
    OFFICIAL_PLUGIN_DEFINITIONS.splice(0, OFFICIAL_PLUGIN_DEFINITIONS.length, ...original);
  });
  const selected = original.filter(({ name }) =>
    officePlugins.some((plugin) => plugin.name === name),
  );
  for (const definition of selected)
    definition.rootCandidates = [`packages/${definition.name}-plugin`];
  OFFICIAL_PLUGIN_DEFINITIONS.splice(0, OFFICIAL_PLUGIN_DEFINITIONS.length, ...selected);
  return owner;
}
