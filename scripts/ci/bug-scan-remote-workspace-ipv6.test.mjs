import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("SSH IPv6 and existing workspace identity formats round-trip", async (t) => {
  const result = await runSourceTests(["packages/shared/test/bugScanRemoteWorkspaceIpv6.test.ts"]);
  assert.equal(result.tests, 21);
  t.diagnostic(`${result.tests} source tests executed`);
});
