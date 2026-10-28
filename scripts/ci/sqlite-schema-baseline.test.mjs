import assert from "node:assert/strict";
import test from "node:test";

// 隔离 wrapper 原先静默忽略更新参数；验证入口不得借此改写冻结基线。
if (process.argv.includes("--update-reviewed-baseline")) {
  throw new Error("SQLITE_SCHEMA_BASELINE_UPDATE_NOT_SUPPORTED");
}
const { runSourceTests } = await import("./source-test-runner.mjs");

test("sqlite-schema-baseline regressions execute inside a project-owned child", async () => {
  const { tests } = await runSourceTests(["scripts/ci/fixtures/sqlite-schema-baseline.test.mjs"]);
  assert.equal(tests, 2);
});
