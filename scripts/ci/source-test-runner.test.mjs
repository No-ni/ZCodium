import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runSourceTests } from "./source-test-runner.mjs";

test("source runner executes real tests inside node:test and propagates failures and missing files", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "zcodium-test-runner-"));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  });
  const passing = join(directory, "passing.test.mjs");
  const failing = join(directory, "failing.test.mjs");
  await writeFile(
    passing,
    'import test from "node:test"; test("executed child fixture", () => {});',
  );
  await writeFile(
    failing,
    'import test from "node:test"; test("failing child fixture", () => { throw new Error("EXPECTED_FIXTURE_FAILURE"); });',
  );
  const result = await runSourceTests([passing]);
  assert.match(result.stdout, /ok 1 - executed child fixture/);
  assert.equal(result.tests, 1);
  await assert.rejects(runSourceTests([failing]), (error) => {
    assert.match(error.stdout, /EXPECTED_FIXTURE_FAILURE/);
    return true;
  });
  await assert.rejects(runSourceTests([passing, join(directory, "missing.test.mjs")]));
});
