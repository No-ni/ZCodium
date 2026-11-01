import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("历史导入与退役 ACP 夹具遵守异步启动 owner", async () => {
  const result = await runSourceTests([
    "packages/services/test/importedClaudeRecovery.test.ts",
    "packages/services/test/nonCliAcpRetirement.test.ts",
  ]);
  assert.equal(result.tests, 8);
  assert.match(result.stdout, /^# pass 8$/m);
  assert.match(result.stdout, /^# fail 0$/m);
  assert.match(result.stdout, /^# skipped 0$/m);
});
