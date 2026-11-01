import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("background task merge and status projection retain bounded runtime facts", async (t) => {
  const result = await runSourceTests([
    "packages/shared/test/bugScanBackgroundTaskControl.test.ts",
  ]);
  assert.equal(result.tests, 5);
  t.diagnostic(`${result.tests} source tests executed`);
});
