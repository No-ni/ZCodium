import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tsImport } from "tsx/esm/api";

const {
  resolveZCodeBuiltinProviderConfigFilePath,
  materializeZCodeBuiltinProviderConfig,
  ZCODE_BUILTIN_PROVIDER_CONFIG_RELATIVE_PATH,
} = await tsImport("../../packages/provider-node/src/index.ts", import.meta.url);

const bundled = JSON.parse(
  await readFile(new URL("../../config/provider/zcode-builtin.json", import.meta.url), "utf8"),
);

function keysOf(source) {
  // locale 是 TS 扁平字符串表：两空格缩进的 "dotted.key": 行才是键，
  // 其余以引号开头的行是译文折行的续行，必须排除，否则会把译文当键。
  return new Set(
    [...source.matchAll(/^ {2}"([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)+)":/gm)].map((m) => m[1]),
  );
}

test("locale zh-CN 与 en-US 键集一致", async () => {
  const zh = keysOf(
    await readFile(new URL("../../packages/ui/src/i18n/locales/zh-CN.ts", import.meta.url), "utf8"),
  );
  const en = keysOf(
    await readFile(new URL("../../packages/ui/src/i18n/locales/en-US.ts", import.meta.url), "utf8"),
  );
  const zhOnly = [...zh].filter((k) => !en.has(k));
  const enOnly = [...en].filter((k) => !zh.has(k));
  assert.deepEqual(zhOnly, [], `zh-CN 独有的键：${zhOnly.join(", ")}`);
  assert.deepEqual(enOnly, [], `en-US 独有的键：${enOnly.join(", ")}`);
});

test("appHeader.goToProviderConfig 双语齐备", async () => {
  const zh = keysOf(
    await readFile(new URL("../../packages/ui/src/i18n/locales/zh-CN.ts", import.meta.url), "utf8"),
  );
  const en = keysOf(
    await readFile(new URL("../../packages/ui/src/i18n/locales/en-US.ts", import.meta.url), "utf8"),
  );
  for (const id of [
    "appHeader.goToProviderConfig",
    "appHeader.builtinProviderConfigOpenFailed",
    "appHeader.builtinProviderConfigMissing",
    "appHeader.builtinProviderConfigUnsupported",
  ]) {
    assert.ok(zh.has(id), `zh-CN 缺少 ${id}`);
    assert.ok(en.has(id), `en-US 缺少 ${id}`);
  }
});

test("物化路径派生单一来源：resolve 与 materialize 落点一致", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "zcodium-provider-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const derived = resolveZCodeBuiltinProviderConfigFilePath(root);
  const expected = join(root, ...ZCODE_BUILTIN_PROVIDER_CONFIG_RELATIVE_PATH);
  assert.equal(derived, expected);

  // materialize 必须写在同一路径：桌面菜单读的是这个派生结果，
  // 若两处字面量漂移，用户点「前往配置」会打开一个空/旧文件。
  const materialized = await materializeZCodeBuiltinProviderConfig({
    environmentConfigRoot: root,
    content: JSON.stringify(bundled),
  });
  assert.equal(materialized, derived);
});
