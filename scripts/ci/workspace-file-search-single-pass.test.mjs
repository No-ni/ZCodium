import assert from "node:assert/strict";
import { test } from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("工作区文件搜索分批单次打分回归", async () => {
  const result = await runSourceTests([
    "packages/services/test/workspaceFileSearchSinglePass.test.ts",
  ]);
  assert.equal(result.tests, 9);
  assert.match(result.stdout, /^# pass 9$/m);
  assert.match(result.stdout, /^# fail 0$/m);
  assert.match(result.stdout, /^# skipped 0$/m);
});
