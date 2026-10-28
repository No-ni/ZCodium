import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createProjectTestSandbox, projectRoot } from "./project-test-sandbox.mjs";

const run = promisify(execFile);
const baselines = [
  "packages/services/src/session/tasksDatabase/schema.baseline.sql",
  "apps/zcode-cli/packages/adapters/src/storage/session-store/schema.baseline.sql",
];

for (const file of [
  "scripts/ci/sqlite-schema-baseline.test.mjs",
  "scripts/ci/fixtures/sqlite-schema-baseline.test.mjs",
]) {
  test(`${file} rejects the retired update flag before creating fixtures or changing baselines`, async () => {
    const sandbox = await createProjectTestSandbox("baseline-update-rejected");
    const directories = await readdir(sandbox.root);
    const before = await Promise.all(baselines.map((path) => readFile(join(projectRoot, path))));
    await assert.rejects(
      run(process.execPath, ["--import", "tsx", file, "--update-reviewed-baseline"], {
        cwd: projectRoot,
        env: sandbox.env,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      }),
      (error) => {
        assert.match(error.stderr, /SQLITE_SCHEMA_BASELINE_UPDATE_NOT_SUPPORTED/);
        return true;
      },
    );
    assert.deepEqual(await readdir(sandbox.root), directories);
    const after = await Promise.all(baselines.map((path) => readFile(join(projectRoot, path))));
    assert.deepEqual(after, before);
  });
}
