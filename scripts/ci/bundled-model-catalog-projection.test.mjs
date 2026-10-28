import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("bundled model catalog projections remain offline in an isolated child", async () => {
  const { tests } = await runSourceTests([
    "scripts/ci/fixtures/bundled-model-catalog-projection.test.mjs",
  ]);
  assert.equal(tests, 5);
});
