import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("插件名称缩写查找不得命中原型链", async (t) => {
  const result = await runSourceTests(["packages/shared/test/pluginDisplayNamePrototype.test.ts"]);
  assert.equal(result.tests, 7);
  t.diagnostic(`${result.tests} source tests executed`);
});
