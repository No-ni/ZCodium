import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  assertProjectPath,
  createProjectTestSandbox,
  projectRoot,
} from "./project-test-sandbox.mjs";

const run = promisify(execFile);

for (const [name, file, pattern] of [
  [
    "lifecycle",
    "automationLifecycleControls.test.ts",
    "^a successful in-flight dispatch preserves pause until the user resumes$",
  ],
  [
    "settlement",
    "automationScheduledSettlement.test.ts",
    "^first successful settlement advances run ledger and counters in one transaction$",
  ],
  [
    "yearly",
    "automationYearlyFeasibility.test.ts",
    "^yearly selecting a calendar-impossible month/day is rejected at creation$",
  ],
]) {
  test(name + " fixture rejects an unbound sandbox before creating directories", async () => {
    const sandbox = await createProjectTestSandbox("automation-unbound");
    // 只撤销业务夹具的沙箱绑定；HOME/TEMP/缓存与 Node 写白名单仍在项目内，不能用真实 TEMP 验证拒绝。
    const env = { ...sandbox.env };
    delete env.PROJECT_TEST_SANDBOX_ROOT;
    delete env.NODE_TEST_CONTEXT;
    env.TSX_DISABLE_CACHE = "1";
    const before = await readdir(sandbox.temp);
    let output;
    let exitCode = 0;
    try {
      output = await run(
        process.execPath,
        [
          "--import",
          "tsx",
          "--test",
          "--test-reporter=tap",
          "--test-name-pattern",
          pattern,
          await assertProjectPath(join(projectRoot, "packages/services/test", file)),
        ],
        { cwd: projectRoot, env, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      );
    } catch (error) {
      exitCode = typeof error.code === "number" ? error.code : -1;
      output = { stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
    }
    const text = output.stdout + "\n" + output.stderr;
    const logPath = await assertProjectPath(join(sandbox.logs, "unbound-source-test.log"));
    await writeFile(logPath, text, { flag: "wx" });
    assert.equal(exitCode, 1, "Unbound source test must be rejected, not skipped or accepted");
    assert.match(text, /PROJECT_TEST_PATH_REJECTED/);
    assert.match(text, /# fail 1(?:\r?\n|$)/);
    assert.deepEqual(
      await readdir(sandbox.temp),
      before,
      "Rejected fixture must leave TEMP untouched",
    );
    assert.equal((await readdir(sandbox.root)).includes("fixtures"), false);
  });
}
