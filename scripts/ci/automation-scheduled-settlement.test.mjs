import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("Scheduled automation settlement is idempotent per runId", async (t) => {
  const { tests } = await runSourceTests([
    "packages/services/test/automationScheduledSettlement.test.ts",
  ]);
  // 阈值随实际用例数更新：幂等/对照探针/回滚/乱序/终态单调/成功与失败的 owner 边界/跨行绑定/legacy 兼容。
  assert.ok(tests >= 19, `settlement 回归至少 19 项，实际 ${tests}`);
  t.diagnostic(`${tests} tests executed`);
});
