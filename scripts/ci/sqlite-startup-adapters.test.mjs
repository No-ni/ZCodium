import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("sqlite-startup-adapters regressions execute inside a project-owned child", async () => {
  const { tests } = await runSourceTests(["scripts/ci/fixtures/sqlite-startup-adapters.test.mjs"]);
  assert.equal(tests, 20);
});
