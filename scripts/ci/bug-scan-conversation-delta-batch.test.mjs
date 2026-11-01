import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("conversation delta batches preserve projection and bounded pre-scan work", async (t) => {
  const result = await runSourceTests([
    "packages/shared/test/bugScanConversationDeltaBatch.test.ts",
  ]);
  assert.equal(result.tests, 9);
  t.diagnostic(`${result.tests} source tests executed`);
  const observation = result.stdout.split(/\r?\n/).find((line) => line.includes("op reads="));
  if (observation) t.diagnostic(observation.replace(/^# /, ""));
});
