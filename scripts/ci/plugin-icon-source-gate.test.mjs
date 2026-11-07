import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("plugin icon enrichment stays local-only without an explicit self-hosted source", async (t) => {
  const result = await runSourceTests([
    "apps/zcode-cli/packages/adapters/test/plugin-icon-source-gate.test.ts",
  ]);
  assert.equal(result.tests, 6);
  t.diagnostic(`${result.tests} source tests executed`);
});
