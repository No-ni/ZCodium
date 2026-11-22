import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("official missed wiring regressions execute in a project-owned child", async () => {
  const { tests } = await runSourceTests(["scripts/ci/fixtures/official-missed-wiring.test.mjs"]);
  assert.equal(tests, 6);
});
