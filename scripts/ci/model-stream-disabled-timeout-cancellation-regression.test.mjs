import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("禁用 SSE idle timeout 的取消回归", async (t) => {
  const result = await runSourceTests([
    "apps/zcode-cli/packages/adapters/test/model-stream-disabled-timeout-cancellation.test.ts",
  ]);
  assert.equal(result.tests, 14);
  assert.match(result.stdout, /^# pass 14$/m);
  assert.match(result.stdout, /^# fail 0$/m);
  assert.match(result.stdout, /^# skipped 0$/m);
  t.diagnostic(`${result.tests} tests executed`);
});
