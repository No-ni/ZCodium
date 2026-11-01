import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("存储扫描 Worker 取消预算与退出收敛回归", async (t) => {
  const result = await runSourceTests([
    "packages/desktop/src/main/storageScanWorkerClient.test.ts",
  ]);
  assert.equal(result.tests, 12, "必须完整执行 10 项可控 Worker 回归与 2 项真实 Worker 冒烟");
  t.diagnostic(`${result.tests} tests executed`);
});
