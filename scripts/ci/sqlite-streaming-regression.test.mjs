import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("streaming SQLite backup regressions execute in a project-owned child", async () => {
  const { tests } = await runSourceTests([
    "scripts/ci/fixtures/sqlite-streaming-regression.test.mjs",
  ]);
  assert.equal(tests, 5);
});
