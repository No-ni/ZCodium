import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { parse } from "yaml";

// 直接解析真实工作流（公开入口），断言 job 条件与 needs 图语义，
// 而不是复制一份手写函数；工作流文件是唯一事实来源。
const workflowPath = resolve(import.meta.dirname, "../../.github/workflows/desktop.yml");

async function loadJobs() {
  const document = parse(await readFile(workflowPath, "utf8"));
  return document.jobs;
}

const uses = (job, prefix) =>
  job.steps.filter((step) => String(step.uses ?? "").startsWith(prefix));

test("desktop workflow is valid YAML with the expected jobs", async () => {
  const jobs = await loadJobs();
  assert.deepEqual(Object.keys(jobs).sort(), [
    "build",
    "build-macos",
    "checks",
    "release",
    "remote-assets",
  ]);
});

test("remote assets start independently of checks and only gate on cancellation", async () => {
  const jobs = await loadJobs();
  const assets = jobs["remote-assets"];
  // coverage 不生产远端资产；不能让独立 producer 白等整段检查完成。
  assert.equal(assets.needs, undefined);
  assert.equal(String(assets.if).trim(), "${{ !cancelled() }}");
  // 明确不按 checks 的 success 结果门禁，否则 checks 红时资产 job 会被跳过。
  assert.doesNotMatch(String(assets.if), /needs\.checks\.result|success\(\)/);
  assert.equal(uses(assets, "actions/upload-artifact").length, 1);
});

test("build consumes real assets, not checks success, and never silently falls back", async () => {
  const jobs = await loadJobs();
  for (const id of ["build", "build-macos"]) {
    const job = jobs[id];
    assert.deepEqual(job.needs, "remote-assets");
    const condition = String(job.if);
    assert.match(condition, /!cancelled\(\)/);
    assert.match(condition, /needs\.remote-assets\.result == 'success'/);
    // 只看 assets 成功，不因 checks 失败跳过打包。
    assert.doesNotMatch(condition, /needs\.checks\.result/);
    const downloads = uses(job, "actions/download-artifact").filter(
      (step) => step.with?.name === "bundled-remote-linux-x64",
    );
    assert.equal(downloads.length, 1);
    for (const step of job.steps) {
      assert.notEqual(step["continue-on-error"], true);
      if (step.uses?.startsWith("actions/download-artifact"))
        assert.notEqual(step.with?.["if-no-files-found"], "ignore");
    }
  }
});

test("parallel packaging preserves coverage commands, full targets and current-run artifact ownership", async () => {
  const jobs = await loadJobs();
  const commands = jobs.checks.steps.map((step) => step.run ?? "").join("\n");
  for (const command of [
    "pnpm typecheck",
    "pnpm lint",
    "pnpm fmt:check",
    "pnpm architecture:check",
    "pnpm -r --filter './apps/zcode-cli/packages/*' test",
    "pnpm vitest run",
    "node --test --test-isolation=none scripts/ci/*.test.mjs",
    "node scripts/ci/remote-form-smoke.mjs",
  ]) {
    assert.ok(commands.includes(command), `missing coverage command: ${command}`);
  }
  for (const id of ["build", "build-macos"]) {
    const job = jobs[id];
    assert.equal(job.env?.ZCODE_DESKTOP_LINUX_TARGETS, undefined);
    for (const download of uses(job, "actions/download-artifact")) {
      assert.equal(download.with?.["run-id"], undefined);
      assert.equal(download.with?.repository, undefined);
    }
    const commands = job.steps.map((step) => step.run ?? "");
    const verify = commands.indexOf("node scripts/bundle-remote-assets.mjs verify");
    const prepare = commands.indexOf("pnpm prepare:desktop-runtime");
    const build = commands.indexOf("pnpm build:bootstrap");
    assert.ok(verify >= 0 && prepare > verify && build > prepare);
    assert.ok(commands.some((command) => command.includes("--skip-prepare --skip-build")));
  }
});

test("release still requires checks success before publishing a draft", async () => {
  const jobs = await loadJobs();
  const release = jobs.release;
  // 默认 needs 语义要求全部 needs success；checks 在列表内即发布 guard。
  assert.deepEqual(release.needs, ["checks", "build", "build-macos"]);
  assert.equal(release.if, "github.event_name == 'push' && github.ref_type == 'tag'");
  assert.equal(release["continue-on-error"], undefined);
});
