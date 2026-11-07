import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("真实项目任务读取与侧栏叶子不保留旧等待状态", { timeout: 90_000 }, async (t) => {
  const result = await runSourceTests(
    ["scripts/ci/fixtures/project-task-live-interaction-runtime.test.mjs"],
    { tsconfig: "packages/ui/tsconfig.json" },
  );
  assert.equal(result.tests, 15);
  t.diagnostic(`15 scenarios; sandbox=${result.sandboxRoot}`);
});
