import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("workflow dependencies, model admission, atomic fills and cold resume execute against source", async (t) => {
  // 包公开入口默认指向 dist；映射到源码，避免旧编译文件让回归测试检查另一份实现。
  const { tests } = await runSourceTests(
    [
      "apps/zcode-cli/packages/dynamic-workflow/test/actor-models.test.ts",
      "apps/zcode-cli/packages/dynamic-workflow/test/hole-data-graph.test.ts",
      "apps/zcode-cli/packages/dynamic-workflow/test/holes-atomic.test.ts",
      "apps/zcode-cli/packages/core/test/workflow-script-models.test.ts",
      "apps/zcode-cli/packages/core/test/workflow-hole-display.test.ts",
      "apps/zcode-cli/packages/core/test/fill-workflow-hole.test.ts",
      "apps/zcode-cli/packages/bootstrap/test/workflow-model-bindings.test.ts",
      "apps/zcode-cli/packages/bootstrap/test/dynamic-workflow-stale-approval.test.ts",
      "apps/zcode-cli/packages/bootstrap/test/dynamic-workflow-holes-integration.test.ts",
    ],
    { tsconfig: "scripts/ci/tsconfig.workflow-tests.json" },
  );
  assert.ok(tests >= 30, `Expected the full regression group, got ${tests} tests`);
  t.diagnostic(`Executed ${tests} source regressions`);
});
