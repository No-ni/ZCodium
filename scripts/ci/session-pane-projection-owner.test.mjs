import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("WSC11：会话切换首帧不能消费上一 owner 的投影", { timeout: 90_000 }, async (t) => {
  const result = await runSourceTests([
    "scripts/ci/fixtures/session-pane-projection-owner-runtime.test.mjs",
  ]);
  t.diagnostic(`${result.tests} tests; ${result.sandboxRoot}`);
});
