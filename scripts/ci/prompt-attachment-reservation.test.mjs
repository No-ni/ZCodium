import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("暂存附件的发送预留、交接和退出回收遵守唯一所有权", { timeout: 30_000 }, async (t) => {
  const result = await runSourceTests([
    "scripts/ci/fixtures/prompt-attachment-reservation-runtime.test.mjs",
  ]);
  t.diagnostic(`${result.tests} tests; ${result.logPath}`);
});
