import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("Composer Recent 项目继承与接纳恢复回归", async (t) => {
  const result = await runSourceTests(["scripts/ci/fixtures/composer-recent-scope.test.mjs"], {
    tsconfig: "packages/ui/tsconfig.json",
  });
  assert.ok(result.tests >= 21);
  assert.match(result.stdout, /^# fail 0$/m);
  assert.match(result.stdout, /^# skipped 0$/m);
  t.diagnostic(`${result.tests} tests executed; ${result.logPath}`);
});
