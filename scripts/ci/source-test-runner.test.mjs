import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runSourceTests } from "./source-test-runner.mjs";
import {
  createProjectTestFixture,
  createProjectTestSandbox,
  projectRoot,
} from "./project-test-sandbox.mjs";

test("source runner executes real tests inside node:test and propagates failures and missing files", async () => {
  const sandbox = await createProjectTestSandbox("test-runner");
  const directory = await createProjectTestFixture("test-runner", sandbox.env);
  const passing = join(directory, "passing.test.mjs");
  const failing = join(directory, "failing.test.mjs");
  await writeFile(
    passing,
    'import assert from "node:assert/strict"; import { homedir, tmpdir } from "node:os"; import test from "node:test"; test("executed child fixture", () => { assert.equal(homedir(), process.env.HOME); assert.equal(tmpdir(), process.env.TEMP); assert.equal(process.env.ZCODE_SERVER_ROOT, undefined); assert.equal(process.permission.has("fs.write", process.env.PROJECT_TEST_SANDBOX_ROOT), true); });',
  );
  await writeFile(
    failing,
    'import test from "node:test"; test("failing child fixture", () => { throw new Error("EXPECTED_FIXTURE_FAILURE"); });',
  );
  const result = await runSourceTests([passing]);
  assert.match(result.stdout, /ok 1 - executed child fixture/);
  assert.equal(result.tests, 1);
  assert.match(await readFile(result.logPath, "utf8"), /ok 1 - executed child fixture/);
  assert.deepEqual(JSON.parse(await readFile(join(result.sandboxRoot, "results.json"), "utf8")), {
    exitCode: 0,
    tests: 1,
    logFile: "logs/source-tests.log",
  });
  let failure;
  await assert.rejects(runSourceTests([failing]), (error) => {
    assert.match(error.stdout, /EXPECTED_FIXTURE_FAILURE/);
    failure = error;
    return true;
  });
  assert.match(await readFile(failure.logPath, "utf8"), /EXPECTED_FIXTURE_FAILURE/);
  const record = JSON.parse(await readFile(join(failure.sandboxRoot, "results.json"), "utf8"));
  assert.equal(record.exitCode, 1);
  assert.equal(record.tests, 1);
  await assert.rejects(runSourceTests([passing, join(directory, "missing.test.mjs")]));
  await assert.rejects(runSourceTests([dirname(projectRoot)]), /PROJECT_TEST_PATH_REJECTED/);
});
