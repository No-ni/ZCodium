import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("PTW 无项目任务目录、恢复与产物归属回归", async (t) => {
  const result = await runSourceTests(
    [
      "scripts/ci/fixtures/projectless-task-navigation.test.mjs",
      "scripts/ci/fixtures/projectless-task-admission.test.mjs",
      "scripts/ci/fixtures/projectless-task-output.test.mjs",
    ],
    { tsconfig: "packages/ui/tsconfig.json" },
  );
  assert.ok(result.tests >= 20);
  assert.match(result.stdout, /^# fail 0$/m);
  assert.match(result.stdout, /^# skipped 0$/m);
  t.diagnostic(`${result.tests} tests executed; ${result.logPath}`);
});
