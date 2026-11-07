import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createProjectTestSandbox, projectRoot } from "./project-test-sandbox.mjs";

test("WSC09：思考耗时沿用事实起点、结束冻结且时钟仅刷新文案", { timeout: 60_000 }, async (t) => {
  const sandbox = await createProjectTestSandbox("session-reasoning-duration");
  const run = promisify(execFile);
  let output;
  try {
    output = await run(
      process.execPath,
      [
        "--test",
        "--test-reporter=tap",
        join(import.meta.dirname, "fixtures/session-reasoning-duration-runtime.test.mjs"),
      ],
      {
        cwd: projectRoot,
        env: { ...sandbox.env, NODE_ENV: "test" },
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
  } catch (error) {
    output = { stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
    await writeFile(join(sandbox.logs, "regression.log"), `${output.stdout}\n${output.stderr}`);
    assert.fail(`思考耗时回归失败：\n${output.stdout}\n${output.stderr}`);
  }
  await writeFile(join(sandbox.logs, "regression.log"), `${output.stdout}\n${output.stderr}`);
  assert.match(output.stdout, /# tests 6\b/);
  assert.match(output.stdout, /# pass 6\b/);
  assert.match(output.stdout, /# fail 0\b/);
  assert.match(output.stdout, /# skipped 0\b/);
  t.diagnostic(`6/6 passed; sandbox=${sandbox.root}`);
});
