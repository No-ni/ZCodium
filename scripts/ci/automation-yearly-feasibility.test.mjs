import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("Yearly automation schedule feasibility is validated at persistence boundary", async (t) => {
  const { tests } = await runSourceTests([
    "packages/services/test/automationYearlyFeasibility.test.ts",
  ]);
  // 阈值随实际用例数更新：窄口径拒绝 + Feb29/monthly/多值防错拒 + anchor 回退 + 重锚定正向回归。
  assert.ok(tests >= 7, `yearly 可行性回归至少 7 项，实际 ${tests}`);
  t.diagnostic(`${tests} tests executed`);
});
