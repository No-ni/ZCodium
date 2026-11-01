import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("RPC 单次事件同步订阅与握手生命周期回归", async (t) => {
  const result = await runSourceTests(["packages/rpc/test/onceSynchronousSubscription.test.ts"]);
  assert.equal(result.tests, 8);
  t.diagnostic(`${result.tests} real source tests executed`);
});
