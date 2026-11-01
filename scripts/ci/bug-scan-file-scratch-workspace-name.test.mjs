import assert from "node:assert/strict";
import { test } from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("scratch workspace 名称点段逃逸回归", async () => {
  const result = await runSourceTests([
    "packages/services/test/bugScanFileScratchWorkspaceName.test.ts",
  ]);
  assert.equal(result.tests, 4);
  assert.match(result.stdout, /^# pass 4$/m);
  assert.match(result.stdout, /^# fail 0$/m);
  assert.match(result.stdout, /^# skipped 0$/m);
});
