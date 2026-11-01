import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("RPC 通道客户端不变量模型与事件交叠回归", async (t) => {
  const result = await runSourceTests(["packages/rpc/test/bugScanChannelClientFuzz.test.ts"]);
  assert.equal(result.tests, 3);
  t.diagnostic(`${result.tests} real source tests executed`);
});
