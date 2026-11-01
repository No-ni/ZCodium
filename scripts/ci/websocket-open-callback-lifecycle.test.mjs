import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("WebSocket open 回调关闭、异常与正常连接回归", async (t) => {
  const result = await runSourceTests([
    "packages/server/test/websocketOpenCallbackLifecycle.test.ts",
  ]);
  assert.equal(result.tests, 3);
  t.diagnostic(`${result.tests} real loopback source tests executed`);
});
