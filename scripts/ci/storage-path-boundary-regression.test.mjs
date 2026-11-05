import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("storage 扫描及清理拒绝根和祖先链接，保留正常路径", async (t) => {
  const result = await runSourceTests([
    "scripts/ci/fixtures/storage-path-boundary-regression.test.mjs",
  ]);
  assert.equal(result.tests, 8);
  t.diagnostic(`${result.tests} real storage filesystem boundary scenarios executed`);
});
