import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("远端 workspace 准备失败沿用唯一 Registry 生命周期", async (t) => {
  const result = await runSourceTests([
    "scripts/ci/fixtures/remote-registry-workspace-failure.test.mjs",
  ]);
  assert.equal(result.tests, 5);
  t.diagnostic(`${result.tests} real Registry lifecycle scenarios executed`);
});
