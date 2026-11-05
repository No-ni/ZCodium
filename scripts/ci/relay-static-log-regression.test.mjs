import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("relay 静态读取拒绝路径和链接越界，生命周期日志仅输出安全字段", async (t) => {
  const result = await runSourceTests(["scripts/ci/fixtures/relay-static-log-regression.test.mjs"]);
  assert.equal(result.tests, 4);
  t.diagnostic(`${result.tests} real relay HTTP/CLI scenarios executed`);
});
