import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("RPC 通道客户端事件订阅/取消/错误传播边界回归", async (t) => {
  const result = await runSourceTests(["packages/rpc/test/bugScanChannelClientBoundary.test.ts"]);
  assert.equal(result.tests, 12);
  t.diagnostic(`${result.tests} real source tests executed`);
});
