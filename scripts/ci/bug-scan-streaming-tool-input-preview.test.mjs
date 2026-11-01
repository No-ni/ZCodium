import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("streaming tool preview respects JSON fields and bounded full-input scans", async (t) => {
  const result = await runSourceTests([
    "packages/shared/test/bugScanStreamingToolInputPreview.test.ts",
  ]);
  assert.equal(result.tests, 48);
  t.diagnostic(`${result.tests} source tests executed`);
  const observation = result.stdout.split(/\r?\n/).find((line) => line.includes("raw characters="));
  if (observation) t.diagnostic(observation.replace(/^# /, ""));
});
