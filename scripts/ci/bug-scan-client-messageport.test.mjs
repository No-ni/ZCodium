import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("client messageport and RemoteServiceAccess lifecycle regressions", async (t) => {
  const result = await runSourceTests(["packages/client/test/bugScanMessageportLifecycle.test.ts"]);
  // 数量变化必须同步更新入口断言，防止缺文件或提前结束被误报为通过。
  assert.equal(result.tests, 16);
  t.diagnostic(`${result.tests} source tests executed`);
});
