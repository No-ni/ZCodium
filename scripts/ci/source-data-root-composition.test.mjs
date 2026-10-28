import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("Source composition and CLI persistence regressions execute in isolated children", async () => {
  const composition = await runSourceTests([
    "scripts/ci/fixtures/source-data-root-composition.test.mjs",
  ]);
  assert.equal(composition.tests, 5);
  const cli = await runSourceTests(
    ["apps/zcode-cli/packages/adapters/test/source-data-roots.test.ts"],
    {
      tsconfig: "apps/zcode-cli/packages/adapters/test/tsconfig.source-data-roots.json",
    },
  );
  assert.equal(cli.tests, 11);
  const enumeration = await runSourceTests(
    ["apps/zcode-cli/packages/bootstrap/test/session-enumeration-startup.test.ts"],
    {
      tsconfig: "apps/zcode-cli/packages/bootstrap/test/tsconfig.session-enumeration.json",
    },
  );
  assert.equal(enumeration.tests, 7);
});
