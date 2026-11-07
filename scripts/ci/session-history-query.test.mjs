import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";
test("历史查询与实时帧的同源陈旧读防护", { timeout: 90_000 }, async (t) => {
  const result = await runSourceTests([
    "scripts/ci/fixtures/session-history-query-runtime.test.mjs",
  ]);
  assert.equal(result.tests, 30);
  t.diagnostic(`30 scenarios; sandbox=${result.sandboxRoot}`);
});
