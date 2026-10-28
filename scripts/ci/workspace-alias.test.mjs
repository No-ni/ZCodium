import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("workspace-alias regressions execute inside a project-owned child", async () => {
  const { tests } = await runSourceTests(["scripts/ci/fixtures/workspace-alias.test.mjs"]);
  assert.equal(tests, 92);
});
