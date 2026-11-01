import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("RPC 通道客户端与代理层组合生命周期回归", async (t) => {
  const result = await runSourceTests([
    "packages/rpc/test/bugScanChannelClientProxyComposition.test.ts",
  ]);
  assert.equal(result.tests, 4);
  t.diagnostic(`${result.tests} real source tests executed`);
});
