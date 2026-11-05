import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("sessions-index observer 迟到失败不得退休新订阅", async (t) => {
  const result = await runSourceTests([
    "scripts/ci/fixtures/sessions-index-observer-retirement.test.mjs",
  ]);
  assert.equal(result.tests, 5);
  t.diagnostic(`${result.tests} real observer lifecycle scenarios executed`);
});
