import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("目录确认准入、双语异常提示与交互执行生产组件", async (t) => {
  const result = await runSourceTests(
    [
      "scripts/ci/fixtures/provider-model-catalog-callbacks.test.mjs",
      "scripts/ci/fixtures/provider-model-catalog-dom.test.mjs",
    ],
    { tsconfig: "packages/ui/tsconfig.json" },
  );
  assert.ok(result.tests >= 12, "至少执行 12 项目录 UI 回归");
  t.diagnostic(result.tests + " source regressions executed");
});
