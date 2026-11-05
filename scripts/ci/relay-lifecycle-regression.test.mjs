import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("relay 启动失败和重复停机释放全部 transport 资源", async (t) => {
  const result = await runSourceTests(["scripts/ci/fixtures/relay-lifecycle-regression.test.mjs"]);
  assert.equal(result.tests, 3);
  t.diagnostic(`${result.tests} real relay lifecycle scenarios executed`);
});
