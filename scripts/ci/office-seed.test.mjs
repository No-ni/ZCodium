import assert from "node:assert/strict";
import test from "node:test";

// seed 回归复用既有 bundled-plugins owner 与四格式真实编译，同样只在项目沙箱子进程内执行（spec §9.5）。
const { runSourceTests } = await import("./source-test-runner.mjs");

test("office-seed regressions execute inside a project-owned child", async () => {
  const { tests } = await runSourceTests(["scripts/ci/fixtures/office-seed.test.mjs"]);
  assert.equal(tests, 1);
});
