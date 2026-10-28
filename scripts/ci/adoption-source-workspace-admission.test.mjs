import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("source workspace admission regressions execute inside a project-owned child", async () => {
  const { tests } = await runSourceTests([
    "scripts/ci/fixtures/adoption-source-workspace-admission.test.mjs",
  ]);
  assert.equal(tests, 25);
});
