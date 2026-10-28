import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("zcode-server-cli ingress token regressions execute inside a project-owned child", async () => {
  const { tests } = await runSourceTests([
    "packages/zcode-server-cli/scripts/ingressToken.test.ts",
  ]);
  assert.equal(tests, 1);
});
