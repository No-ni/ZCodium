import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { format } from "oxfmt";
import { readUpstreamSnapshot } from "../architecture/upstream-snapshot.mjs";
import { runFormatter } from "../check-format.mjs";
import { createProjectTestSandbox } from "../ci/project-test-sandbox.mjs";

const execute = promisify(execFile);
const snapshotPath = "scripts/ci/upstream-format-snapshot.json";
const original = "export const value={x:1};\n";

async function fixture(run) {
  const sandbox = await createProjectTestSandbox("format-snapshot-fixture");
  const cwd = sandbox.root;
  const git = async (...args) =>
    (await execute("git", args, { cwd, env: sandbox.env, windowsHide: true })).stdout.trim();
  await git("init", "-b", "main");
  for (const [key, value] of [
    ["user.name", "Format Fixture"],
    ["user.email", "format@example.invalid"],
    ["commit.gpgsign", "false"],
    ["core.autocrlf", "false"],
    ["core.filemode", "true"],
  ])
    await git("config", key, value);
  await mkdir(join(cwd, "scripts/ci"), { recursive: true });
  await writeFile(join(cwd, "inherited.ts"), original);
  await writeFile(join(cwd, "inherited.html"), "<input></input>\n");
  await writeFile(join(cwd, "inherited[route].ts"), original);
  await writeFile(join(cwd, ".oxfmtrc.json"), "{}\n");
  await git("add", ".");
  const entries = await git("ls-files", "--stage");
  const files = Object.fromEntries(
    entries
      .split("\n")
      .filter((line) => /\tinherited(?:\.|\[)/.test(line))
      .map((line) => {
        const [metadata, file] = line.split("\t");
        const [mode, blob] = metadata.split(" ");
        return [file, `${mode} ${blob}`];
      }),
  );
  const snapshot = await format(
    snapshotPath,
    JSON.stringify({ version: 1, files, introduced: [] }),
  );
  assert.deepEqual(snapshot.errors, []);
  await writeFile(join(cwd, snapshotPath), snapshot.code);
  await git("add", snapshotPath);
  const commit = () => git("-c", "core.hooksPath=", "commit", "-am", "合成格式夹具");
  await commit();
  await run({ cwd, git, commit });
  // 合成数据保留在项目 sandbox，不清理历史或项目外目录。
}

test("官方原样文件和解析失败示例仅在两份 Git 快照匹配时排除", async () => {
  await fixture(async ({ cwd }) => {
    const originalFiles = (await readdir(cwd)).sort();
    const { accepted } = await readUpstreamSnapshot(cwd, snapshotPath);
    assert.deepEqual([...accepted].sort(), [
      "inherited.html",
      "inherited.ts",
      "inherited[route].ts",
    ]);
    const result = await runFormatter({ cwd, args: ["--check", "inherited.ts", "inherited.html"] });
    assert.equal(result.exitCode, 0, result.stdout + result.stderr);
    assert.equal(result.inheritedFiles, 3);
    const directoryResult = await runFormatter({ cwd, args: ["--check", "."] });
    assert.equal(directoryResult.exitCode, 0, directoryResult.stdout + directoryResult.stderr);
    const writeResult = await runFormatter({ cwd, args: ["--write", "inherited.ts"] });
    assert.equal(writeResult.exitCode, 0);
    assert.equal(await readFile(join(cwd, "inherited.ts"), "utf8"), original);
    assert.deepEqual((await readdir(cwd)).sort(), originalFiles);
  });
});

test("继承排除精确锚定目录，原配置的相对忽略规则保留", async () => {
  await fixture(async ({ cwd }) => {
    await mkdir(join(cwd, "local"));
    await mkdir(join(cwd, "generated"));
    await writeFile(join(cwd, "local/inherited.ts"), original);
    await writeFile(join(cwd, "generated/example.html"), "<input></input>\n");
    const config = await format(
      ".oxfmtrc.json",
      JSON.stringify({ ignorePatterns: ["generated/**"] }),
    );
    assert.deepEqual(config.errors, []);
    await writeFile(join(cwd, ".oxfmtrc.json"), config.code);
    const result = await runFormatter({ cwd, args: ["--check", "."] });
    assert.equal(result.exitCode, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /local[\\/]inherited\.ts/);
    const formatted = await format("local/inherited.ts", original);
    assert.deepEqual(formatted.errors, []);
    await writeFile(join(cwd, "local/inherited.ts"), formatted.code);
    const cleanResult = await runFormatter({ cwd, args: ["--check", "."] });
    assert.equal(cleanResult.exitCode, 0, cleanResult.stdout + cleanResult.stderr);
  });
});

test("自有文件解析失败保留非零退出码并删除本次临时配置", async () => {
  await fixture(async ({ cwd }) => {
    await writeFile(join(cwd, "local.html"), "<input></input>\n");
    const originalFiles = (await readdir(cwd)).sort();
    const result = await runFormatter({ cwd, args: ["--check", "."] });
    assert.ok(result.exitCode > 0, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /Void elements/);
    assert.deepEqual((await readdir(cwd)).sort(), originalFiles);
  });
});

for (const state of [
  "unstaged",
  "staged",
  "staged-then-restored",
  "committed",
  "mode",
  "deleted",
]) {
  test(`${state}：继承文件退出格式例外`, async () => {
    await fixture(async ({ cwd, git, commit }) => {
      if (state === "mode") await git("update-index", "--chmod=+x", "inherited.ts");
      else if (state === "deleted") await git("update-index", "--force-remove", "inherited.ts");
      else {
        await writeFile(join(cwd, "inherited.ts"), "export const value={x:2};\n");
        if (state.startsWith("staged") || state === "committed") await git("add", "inherited.ts");
        if (state === "staged-then-restored") await writeFile(join(cwd, "inherited.ts"), original);
        if (state === "committed") await commit();
      }
      const { accepted } = await readUpstreamSnapshot(cwd, snapshotPath);
      assert.equal(accepted.has("inherited.ts"), false);
      const result = await runFormatter({ cwd, args: ["--check", "inherited.ts"] });
      assert.equal(result.exitCode, 1, result.stdout + result.stderr);
    });
  });
}

test("未登记的新文件仍受格式检查，write 使用同一规则", async () => {
  await fixture(async ({ cwd }) => {
    await writeFile(join(cwd, "local.ts"), original);
    const result = await runFormatter({ cwd, args: ["--check", "local.ts"] });
    assert.equal(result.exitCode, 1);
    assert.equal((await runFormatter({ cwd, args: ["--write", "local.ts"] })).exitCode, 0);
    assert.notEqual(await readFile(join(cwd, "local.ts"), "utf8"), original);
    assert.equal((await runFormatter({ cwd, args: ["--check", "local.ts"] })).exitCode, 0);
  });
});

test("损坏的继承清单使格式入口失败，不静默扩张例外", async () => {
  await fixture(async ({ cwd }) => {
    await writeFile(
      join(cwd, snapshotPath),
      JSON.stringify({ version: 1, files: { "../outside.ts": "bad" } }),
    );
    await assert.rejects(runFormatter({ cwd, args: ["--check", "inherited.ts"] }), /清单无效/);
  });
});
