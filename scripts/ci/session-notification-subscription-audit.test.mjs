import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createProjectTestSandbox, projectRoot } from "./project-test-sandbox.mjs";

test("通知订阅审计：语言变化不能清除同代际恢复的运行基线", { timeout: 60_000 }, async (t) => {
  const sandbox = await createProjectTestSandbox("notification-subscription-audit");
  let result;
  try {
    result = await promisify(execFile)(
      process.execPath,
      [
        "--test",
        "--test-reporter=tap",
        join(
          import.meta.dirname,
          "fixtures/session-notification-subscription-audit-runtime.test.mjs",
        ),
      ],
      {
        cwd: projectRoot,
        env: { ...sandbox.env, NODE_ENV: "test" },
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
  } catch (error) {
    result = { stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
    await writeFile(join(sandbox.logs, "regression.log"), `${result.stdout}\n${result.stderr}`);
    t.diagnostic(`evidence=${sandbox.root}`);
    assert.fail(`通知订阅审计失败：\n${result.stdout}\n${result.stderr}`);
  }
  await writeFile(join(sandbox.logs, "regression.log"), `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /# tests 3\b/);
  assert.match(result.stdout, /# pass 3\b/);
  t.diagnostic(`3/3 passed; evidence=${sandbox.root}`);
});
