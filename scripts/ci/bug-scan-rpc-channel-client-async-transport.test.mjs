import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("RPC 通道客户端真实异步传输生命周期回归", async (t) => {
  const result = await runSourceTests([
    "packages/rpc/test/bugScanChannelClientAsyncTransport.test.ts",
  ]);
  assert.equal(result.tests, 6);
  t.diagnostic(`${result.tests} real source tests executed`);
});
