import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("Source data-root regressions execute in isolated children", async () => {
  const { tests } = await runSourceTests(["scripts/ci/fixtures/source-data-roots.test.mjs"]);
  assert.equal(tests, 4);
});
