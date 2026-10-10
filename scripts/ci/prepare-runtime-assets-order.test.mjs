import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const scriptPath = join(repoRoot, "packages/desktop/scripts/prepare-runtime-assets.mjs");

/** 按出现顺序取出脚本里所有 runTimedPnpmScript("<name>") 字面量。 */
async function readInvokedScripts() {
  const source = await readFile(scriptPath, "utf8");
  return [...source.matchAll(/runTimedPnpmScript\(\s*"([^"]+)"\s*\)/g)].map((match) => match[1]);
}

test("build metadata is written before any version-stamped runtime asset is baked", async () => {
  const invoked = await readInvokedScripts();

  const buildMetaIndex = invoked.indexOf("prepare:build-meta");
  const remoteAssetsIndex = invoked.indexOf("prepare:remote-assets");

  assert.notEqual(buildMetaIndex, -1, "prepare:runtime-assets must refresh build metadata");
  assert.notEqual(remoteAssetsIndex, -1, "prepare:runtime-assets must bake remote assets");
  assert.ok(
    buildMetaIndex < remoteAssetsIndex,
    `prepare:build-meta (index ${buildMetaIndex}) must run before prepare:remote-assets (index ${remoteAssetsIndex}); ` +
      "otherwise a stale build-meta.json stamps a wrong appVersion into the manifest and " +
      "electron-builder's beforePack fails with Bundled remote appVersion mismatch",
  );
});

test("refreshing build metadata is not conditional on the remote-assets skip switch", async () => {
  // ZCODE_SKIP_REMOTE_ASSETS=1 只跳过远端资产生成，electron-builder 仍会校验已下载的
  // 随包清单，所以版本缓存的刷新必须无条件发生。
  const invoked = await readInvokedScripts();
  assert.ok(
    invoked.indexOf("prepare:build-meta") < invoked.indexOf("prepare:remote-assets"),
    "prepare:build-meta must precede the remote-assets branch",
  );
});

test("bundle 不为已显式准备的运行时资产重复跑 prepare:runtime-assets", async () => {
  const bundlePath = join(repoRoot, "packages/desktop/scripts/bundle.mjs");
  const source = await readFile(bundlePath, "utf8");
  const invoked = [...source.matchAll(/run\(pnpmCommand, \[\s*"([^"]+)"/g)].map((m) => m[1]);

  // 只允许出现一次显式的 prepare:runtime-assets；build 脚本自身也以它开头，
  // 串联执行会让 prepare:remote-assets（约 42s）与 prepare:agent-bundle（约 31s）整段重跑。
  assert.equal(
    invoked.filter((name) => name === "prepare:runtime-assets").length,
    1,
    "prepare:runtime-assets 在 bundle.mjs 中只能被显式调用一次",
  );

  // 显式准备之后只能调 build:no-runtime-assets；--skip-prepare 时才走完整 build。
  assert.match(source, /skipPrepare \? "build" : "build:no-runtime-assets"/);
  assert.ok(
    !invoked.includes("build:no-runtime-assets") || invoked.indexOf("build:no-runtime-assets") > 0,
    "build:no-runtime-assets 必须晚于 prepare:runtime-assets",
  );
});
