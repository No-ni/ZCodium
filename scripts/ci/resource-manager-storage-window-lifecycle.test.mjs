import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("资源管理器扫描窗口的启动回应与关闭取消生命周期回归", async (t) => {
  const result = await runSourceTests([
    "packages/desktop/src/main/resourceManagerStorageScanLifecycle.test.ts",
  ]);
  assert.equal(result.tests, 10, "必须完整执行窗口回应生命周期的 10 项回归");
  t.diagnostic(`${result.tests} tests executed; sandbox=${result.sandboxRoot}`);
});
