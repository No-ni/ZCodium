import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("HTTP 远程连接归实例释放，分享沿 attachment 准入", async (t) => {
  const result = await runSourceTests([
    "scripts/ci/fixtures/full-code-audit-http-regression.test.mjs",
  ]);
  assert.equal(result.tests, 8);
  t.diagnostic(
    `${result.tests} real HTTP/WebSocket scenarios with a mocked remote transport executed`,
  );
});
