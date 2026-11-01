import assert from "node:assert/strict";
import { test } from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("HTTP static resource boundaries use project-only fixtures", async () => {
  const result = await runSourceTests(["packages/server/test/httpStaticFiles.test.ts"]);
  assert.ok(result.tests >= 35, "All static resource boundary cases must execute");
});
