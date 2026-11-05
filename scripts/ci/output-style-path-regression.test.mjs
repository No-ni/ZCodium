import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("output style 文件写入不接受路径，列表 ID 精确往返", async (t) => {
  const result = await runSourceTests([
    "scripts/ci/fixtures/output-style-path-regression.test.mjs",
  ]);
  assert.equal(result.tests, 4);
  t.diagnostic(`${result.tests} real output-style filesystem scenarios executed`);
});
