import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("desktop source server rpc regressions execute inside a project-owned child", async () => {
  const { tests } = await runSourceTests(["packages/desktop/scripts/sourceServerRpc.test.ts"]);
  assert.equal(tests, 1);
});
