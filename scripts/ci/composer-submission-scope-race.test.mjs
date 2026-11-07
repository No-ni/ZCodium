import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("Composer 异步提交不能越过会话 scope", { timeout: 90_000 }, async (t) => {
  const result = await runSourceTests(
    ["scripts/ci/fixtures/composer-submission-scope-race-runtime.test.mjs"],
    { tsconfig: "packages/ui/tsconfig.json" },
  );
  t.diagnostic(`${result.tests} tests; ${result.logPath}`);
});
