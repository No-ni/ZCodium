import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("RPC 通道客户端分片装帧与载荷边界回归", async (t) => {
  const result = await runSourceTests([
    "packages/rpc/test/bugScanChannelClientFragmentedFraming.test.ts",
  ]);
  assert.equal(result.tests, 5);
  t.diagnostic(`${result.tests} real source tests executed`);
});
