import assert from "node:assert/strict";
import test from "node:test";

// 分发回归含真实四格式 esbuild 编译与 staging/SEA 采集，必须在 source-test-runner 的项目沙箱子进程内执行；
// fixture 不再写系统临时目录，也不做整根递归清理（spec §9.5）。
const { runSourceTests } = await import("./source-test-runner.mjs");

test("office-distribution regressions execute inside a project-owned child", async () => {
  const { tests } = await runSourceTests(["scripts/ci/fixtures/office-distribution.test.mjs"]);
  assert.equal(tests, 8);
});
