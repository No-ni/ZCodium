import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("Automation pause and execution limits survive dispatch and edits", async (t) => {
  const { tests } = await runSourceTests([
    "packages/services/test/automationLifecycleControls.test.ts",
  ]);
  t.diagnostic(`${tests} tests executed`);
});
