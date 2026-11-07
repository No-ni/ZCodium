import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createProjectTestSandbox, projectRoot } from "./project-test-sandbox.mjs";

// 真实 React hook 和通知编排，端口在内存中；环境、esbuild 输出及日志全限定在工作树。
test("WSC05-08：会话完成通知的 Goal、中断与订阅代际回归", { timeout: 60_000 }, async (t) => {
  const sandbox = await createProjectTestSandbox("session-work-notifications");
  const run = promisify(execFile);
  let output;
  try {
    output = await run(
      process.execPath,
      [
        "--test",
        "--test-reporter=tap",
        join(import.meta.dirname, "fixtures/session-work-notifications-runtime.test.mjs"),
      ],
      {
        cwd: projectRoot,
        env: { ...sandbox.env, NODE_ENV: "test" },
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
  } catch (error) {
    output = { stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
    await writeFile(join(sandbox.logs, "regression.log"), `${output.stdout}\n${output.stderr}`);
    assert.fail(`通知回归失败：\n${output.stdout}\n${output.stderr}`);
  }
  await writeFile(join(sandbox.logs, "regression.log"), `${output.stdout}\n${output.stderr}`);
  assert.match(output.stdout, /# tests 9\b/);
  assert.match(output.stdout, /# pass 9\b/);
  assert.match(output.stdout, /# fail 0\b/);
  assert.match(output.stdout, /# cancelled 0\b/);
  assert.match(output.stdout, /# skipped 0\b/);
  assert.match(output.stdout, /# todo 0\b/);
  t.diagnostic(`9/9 passed; sandbox=${sandbox.root}`);
});
