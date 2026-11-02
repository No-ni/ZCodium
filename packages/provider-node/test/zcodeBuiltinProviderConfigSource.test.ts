import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// 随包 Provider 目录的读取契约：只读、无网络、不信任任何历史下载缓存。
// 运行：见 .agents/specs/official-3.17.1-provider.md 第 6 节（项目内 sandbox runner）。

const { NodeZCodeBuiltinProviderConfigSource } =
  await import("../src/zcode-builtin-provider-config-source.js");

const bundledPath = new URL("../../../config/provider/zcode-builtin.json", import.meta.url);
const bundledText = await readFile(bundledPath, "utf8");
const bundled = JSON.parse(bundledText) as { revision: number };

async function fixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "zcodium-builtin-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "zcode-builtin.json");
  await writeFile(file, bundledText, "utf8");
  return { root, file };
}

function source(file: string, options: { watch?: boolean } = {}) {
  return new NodeZCodeBuiltinProviderConfigSource({ bundledFilePath: file, watch: options.watch });
}

test("只读随包基线：不写文件、不读历史下载缓存、不需要网络", async (t) => {
  const { root, file } = await fixture(t);
  // 上游曾把远端 Release 物化到 Active 缓存并按 revision 取新；本仓必须继续忽略它。
  const staleCache = join(root, "old-downloaded-cache.json");
  await writeFile(
    staleCache,
    JSON.stringify({ ...JSON.parse(bundledText), revision: bundled.revision + 99999 }),
    "utf8",
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("随包 Provider 目录读取不允许出网");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const before = await readdir(root);
  const instance = source(file, { watch: false });
  t.after(() => instance.dispose());
  const snapshot = await instance.read();
  assert.match(snapshot.revision, new RegExp(`^zcode-builtin:${bundled.revision}:`));
  assert.deepEqual(await readdir(root), before);
});

test("同序号不同内容必须改变来源身份，跨进程同内容必须一致", async (t) => {
  const { file } = await fixture(t);
  const host = source(file, { watch: false });
  const worker = source(file, { watch: false });
  t.after(() => {
    host.dispose();
    worker.dispose();
  });
  const first = await host.read();
  assert.equal((await worker.read()).revision, first.revision);
  const changed = structuredClone(JSON.parse(bundledText));
  changed.config.providerConfigRules.templateRules[0].templateNameMap["en-US"] += " revised";
  await writeFile(file, JSON.stringify(changed), "utf8");
  const second = await host.read();
  assert.notEqual(second.revision, first.revision, "同 revision 换内容必须让 Registry 失效旧来源");
  assert.equal((await worker.read()).revision, second.revision);
});

test("目录被运行中清理时沿用本进程随包基线，损坏内容仍要抛错", async (t) => {
  const { root, file } = await fixture(t);
  const instance = source(file, { watch: false });
  t.after(() => instance.dispose());
  const ok = await instance.read();
  // 物化目录被清理：随包基线在进程生命周期内不可变，读取必须继续可用而不是失败到重启。
  await rm(file, { force: true });
  const recovered = await instance.read();
  assert.equal(recovered.revision, ok.revision);
  // 真实损坏不能靠旧数据兜底掩盖。
  await writeFile(file, "not json", "utf8");
  await assert.rejects(instance.read());
  await writeFile(file, JSON.stringify({ ...JSON.parse(bundledText), revision: -1 }), "utf8");
  await assert.rejects(instance.read(), undefined, "Schema 不兼容必须抛错");
  await rm(root, { recursive: true, force: true });
});

test("新实例在缺失目录上仍读不到就失败，监听挂载失败不阻断读取", async (t) => {
  const { root } = await fixture(t);
  const missing = join(root, "runtime", "provider", "bundled", "zcode-builtin.json");
  const cold = source(missing, { watch: true });
  t.after(() => cold.dispose());
  await assert.rejects(cold.read(), undefined, "没有成功读过的路径不能凭空兜底");
  // 监听目标目录不存在时不能完全失效：文件出现后必须能读到并继续监听。
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(root, "runtime", "provider", "bundled"), { recursive: true });
  await writeFile(missing, bundledText, "utf8");
  const warm = source(missing, { watch: true });
  t.after(() => warm.dispose());
  assert.match((await warm.read()).revision, new RegExp(`^zcode-builtin:${bundled.revision}:`));
});

test("dispose 后拒绝继续读取", async (t) => {
  const { file } = await fixture(t);
  const instance = source(file, { watch: false });
  await instance.read();
  instance.dispose();
  await assert.rejects(instance.read());
});
