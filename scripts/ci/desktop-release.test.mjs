import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  artifactNames,
  collectArtifacts,
  publishDraft,
  validateTag,
  verifyReleaseAssets,
} from "./desktop-release.mjs";
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

test("release tag must exactly match a valid package version", () => {
  validateTag("v3.14.0", version);
  validateTag("v3.15.0-rc.1", "3.15.0-rc.1");
  for (const tag of ["3.14.0", "v3.14.1", "v3.14.0\n", "v3.14.0;echo x"]) {
    assert.throws(() => validateTag(tag, version));
  }
  for (const invalid of ["../3.14.0", "03.14.0", "3.14", "3.14.0-01", "3.14.0+build"]) {
    assert.throws(() => validateTag(`v${invalid}`, invalid));
  }
  assert.throws(() => artifactNames("sunos", version));
});

// tag 只标识上游基线（v3.14.4），产物名带的是构建期滚动版本串（#38 起 electron-builder
// 用 extraMetadata.version 命名）。collect 与 publish 的 verifyReleaseAssets 都必须按滚动串
// 匹配，否则 tag 一发就按基线名找不到产物。这里钉住 artifactNames 对 prerelease 串可用。
test("artifact names accept the rolling prerelease build version", () => {
  const rolling = "3.14.4-20261009.258";
  // linux x64 的 AppImage 产物名用 x86_64（builder-util 的 getArtifactArchName 特例）。
  assert.ok(
    artifactNames("linux", rolling, "x64", identity)[0].includes(
      `ZCodium Exp-${rolling}-linux-x86_64`,
    ),
  );
  assert.notEqual(
    artifactNames("linux", rolling, "x64", identity)[0],
    artifactNames("linux", "3.14.4", "x64", identity)[0],
  );
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

test("missing, empty, wrong-version and extra assets block release", async (t) => {
  const missing = await fixture(t, allNames.slice(0, -1));
  await assert.rejects(verifyReleaseAssets(missing, version, identity));
  const empty = await fixture(t);
  await writeFile(join(empty, allNames[0]), "");
  await assert.rejects(verifyReleaseAssets(empty, version, identity), /empty/);
  const extra = await fixture(t);
  await writeFile(join(extra, "ZCodium-3.13.0-win-x64.exe"), "old");
  await assert.rejects(verifyReleaseAssets(extra, version, identity), /Unexpected/);
  const wrongVersion = await fixture(
    t,
    allNames.map((name) => name.replace(version, "3.13.0")),
  );
  await assert.rejects(verifyReleaseAssets(wrongVersion, version, identity));
});

test("checksums cover exactly the fourteen validated installers and can be regenerated", async (t) => {
  const directory = await fixture(t);
  const paths = await verifyReleaseAssets(directory, version, identity);
  const expected = allNames
    .toSorted()
    .map((name) => {
      const hash = createHash("sha256").update(`artifact: ${name}`).digest("hex");
      return `${hash}  ${name}\n`;
    })
    .join("");
  assert.equal(await readFile(join(directory, "SHA256SUMS"), "utf8"), expected);
  assert.equal(paths.length, 15);
  await verifyReleaseAssets(directory, version, identity);
});

function githubMock(releases = []) {
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, ...args]);
    return { stdout: args[1] === "list" ? JSON.stringify(releases) : "" };
  };
  return { run, calls };
}

test("create a draft then upload assets; never publish it", async () => {
  const { run, calls } = githubMock();
  await publishDraft({ tag: "v3.14.0", repo: "owner/repo", files: ["/tmp/artifact"], run });
  assert.equal(calls.length, 3);
  assert.ok(calls[1].includes("--draft"));
  assert.ok(calls[1].includes("--verify-tag"));
  assert.equal(calls[2][2], "upload");
  assert.ok(calls[2].includes("--clobber"));
});

test("rerun updates only a draft and refuses an already public release", async () => {
  const draft = githubMock([{ tagName: "v3.14.0", isDraft: true }]);
  await publishDraft({ tag: "v3.14.0", repo: "owner/repo", files: ["a"], run: draft.run });
  assert.equal(draft.calls.length, 2);
  assert.equal(draft.calls[1][2], "upload");
  const published = githubMock([{ tagName: "v3.14.0", isDraft: false }]);
  await assert.rejects(
    publishDraft({ tag: "v3.14.0", repo: "owner/repo", files: ["a"], run: published.run }),
    /published/,
  );
  assert.equal(published.calls.length, 1);
});

test("prerelease tags create prerelease drafts", async () => {
  const { run, calls } = githubMock();
  await publishDraft({ tag: "v3.14.0-ci.1", repo: "owner/repo", files: ["a"], run });
  assert.ok(calls[1].includes("--draft"));
  assert.ok(calls[1].includes("--prerelease"));
});

test("lookup failures stop before creating or modifying a release", async () => {
  let calls = 0;
  await assert.rejects(
    publishDraft({
      tag: "v3.14.0",
      repo: "owner/repo",
      files: ["a"],
      run: async () => {
        calls++;
        throw new Error("network unavailable");
      },
    }),
    /network unavailable/,
  );
  assert.equal(calls, 1);
});
