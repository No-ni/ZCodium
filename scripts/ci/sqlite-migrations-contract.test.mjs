import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("sqlite-migrations contract regressions execute inside a project-owned child", async () => {
  const { tests } = await runSourceTests([
    "packages/shared/src/sqlite-migrations/contract.test.ts",
  ]);
  assert.equal(tests, 11);
});
