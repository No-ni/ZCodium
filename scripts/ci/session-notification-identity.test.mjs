import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("WSC15：真实 CLI gateway 通知资格边沿保留源事件身份", { timeout: 60_000 }, async (t) => {
  const result = await runSourceTests([
    "scripts/ci/fixtures/session-notification-identity-runtime.test.mjs",
  ]);
  assert.equal(result.tests, 6);
  t.diagnostic(`6 scenarios; evidence=${result.sandboxRoot}`);
});
