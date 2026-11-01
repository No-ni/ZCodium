import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("Markdown artifact 目标替换与无引用快路径回归", async (t) => {
  const result = await runSourceTests(["packages/shared/test/markdown-artifact-images.test.ts"]);
  assert.equal(result.tests, 11);
  t.diagnostic(`${result.tests} tests executed`);
});
