import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("adoption-source-inspection-rpc regressions execute inside a project-owned child", async () => {
  const { tests } = await runSourceTests([
    "scripts/ci/fixtures/adoption-source-inspection-rpc.test.mjs",
  ]);
  assert.equal(tests, 4);
});
