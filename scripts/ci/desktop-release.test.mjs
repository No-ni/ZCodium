import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { artifactNames, collectArtifacts } from "./desktop-release.mjs";
import { desktopProductIdentities } from "../../packages/desktop/scripts/desktop-product-identity.mjs";

const version = "3.14.0";
// 产物名改由构建期产品身份派生（bugfix：曾硬编码 `ZCodium-`，身份改为 `ZCodium Exp`
// 后 CI 的 Build job 全部 ENOENT）。这里显式取 production 身份，使断言不依赖运行环境的
// ZCODE_ENV / ZCODE_PREVIEW_IDENTITY——CI 设了 production，本机裸跑会解析成 Preview。
const identity = desktopProductIdentities.production;
const allNames = [
  ...artifactNames("linux", version, undefined, identity),
  ...artifactNames("win", version, undefined, identity),
  ...artifactNames("mac", version, undefined, identity),
];

async function fixture(t, names = allNames) {
  const directory = await mkdtemp(join(tmpdir(), "zcodium-release-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const name of names) await writeFile(join(directory, name), `artifact: ${name}`);
  return directory;
}

test("artifact names only cover known platforms", () => {
  assert.throws(() => artifactNames("sunos", version));
});

test("collect only installers, excluding unpacked app and builder metadata", async (t) => {
  const source = await fixture(t);
  const output = await fixture(t, []);
  await writeFile(join(source, "latest-linux.yml"), "metadata");
  await collectArtifacts(source, output, "linux", version, "x64", identity);
  assert.equal(await readFile(join(output, allNames[0]), "utf8"), `artifact: ${allNames[0]}`);
  await assert.rejects(readFile(join(output, "latest-linux.yml")), { code: "ENOENT" });
  await assert.rejects(readFile(join(output, artifactNames("win", version, "x64", identity)[0])), {
    code: "ENOENT",
  });
});

test("Windows x64 and arm64 artifacts are collected independently", async (t) => {
  // 交叉打包：x64 job 与 arm64 job 各自只收自己的产物；不传 arch 才收全部。
  const source = await fixture(t);
  const x64 = await fixture(t, []);
  await collectArtifacts(source, x64, "win", version, "x64", identity);
  assert.equal((await readdir(x64)).length, 1);
  assert.equal((await readdir(x64))[0], artifactNames("win", version, "x64", identity)[0]);

  const arm64 = await fixture(t, []);
  await collectArtifacts(source, arm64, "win", version, "arm64", identity);
  assert.equal((await readdir(arm64)).length, 1);
  assert.equal((await readdir(arm64))[0], artifactNames("win", version, "arm64", identity)[0]);

  const both = await fixture(t, []);
  await collectArtifacts(source, both, "win", version, undefined, identity);
  assert.deepEqual((await readdir(both)).sort(), [
    artifactNames("win", version, "arm64", identity)[0],
    artifactNames("win", version, "x64", identity)[0],
  ]);

  await assert.rejects(
    collectArtifacts(source, await fixture(t, []), "win", version, "riscv64", identity),
  );
});

test("macOS arm64 and x64 installers are collected per architecture", async (t) => {
  // 与 Windows 一样按架构分 job 收取：arm64 job 只收 arm64 的 dmg/zip，x64 同理。
  const source = await fixture(t);
  const arm64 = await fixture(t, []);
  await collectArtifacts(source, arm64, "mac", version, "arm64", identity);
  assert.deepEqual((await readdir(arm64)).sort(), [
    artifactNames("mac", version, "arm64", identity).find((n) => n.endsWith(".dmg")),
    artifactNames("mac", version, "arm64", identity).find((n) => n.endsWith(".zip")),
  ]);

  const x64 = await fixture(t, []);
  await collectArtifacts(source, x64, "mac", version, "x64", identity);
  assert.deepEqual((await readdir(x64)).sort(), [
    artifactNames("mac", version, "x64", identity).find((n) => n.endsWith(".dmg")),
    artifactNames("mac", version, "x64", identity).find((n) => n.endsWith(".zip")),
  ]);

  const both = await fixture(t, []);
  await collectArtifacts(source, both, "mac", version, undefined, identity);
  assert.equal((await readdir(both)).length, 4);

  await assert.rejects(
    collectArtifacts(source, await fixture(t, []), "mac", version, "riscv64", identity),
  );
});

test("Linux x64 and arm64 artifacts are collected independently", async (t) => {
  // 修复依据：Linux arm64 与 x64 的产物名差异来自 builder-util 的 getArtifactArchName
  // （AppImage/deb 用 arm64，rpm/pacman 用 aarch64），此前映射表只有 x64 一族，
  // arm64 job 会因找不到预期文件名直接失败。
  const source = await fixture(t);

  const x64 = await fixture(t, []);
  await collectArtifacts(source, x64, "linux", version, "x64", identity);
  assert.deepEqual(
    (await readdir(x64)).sort(),
    [...artifactNames("linux", version, "x64", identity)].sort(),
  );

  const arm64 = await fixture(t, []);
  await collectArtifacts(source, arm64, "linux", version, "arm64", identity);
  assert.deepEqual(
    (await readdir(arm64)).sort(),
    [...artifactNames("linux", version, "arm64", identity)].sort(),
  );

  const both = await fixture(t, []);
  await collectArtifacts(source, both, "linux", version, undefined, identity);
  assert.equal((await readdir(both)).length, 8);
});
