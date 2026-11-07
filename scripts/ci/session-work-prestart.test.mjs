import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createProjectTestSandbox, projectRoot } from "./project-test-sandbox.mjs";

test("已接受输入在真实 Core/App 启动准备失败时同源结算一次", { timeout: 90_000 }, async (t) => {
  const sandbox = await createProjectTestSandbox("session-work-prestart");
  const run = promisify(execFile);
  let result;
  let failure;
  try {
    result = await run(
      process.execPath,
      [
        "--test",
        "--test-reporter=tap",
        join(import.meta.dirname, "fixtures/session-work-prestart-runtime.test.mjs"),
      ],
      {
        cwd: projectRoot,
        env: { ...sandbox.env, NODE_ENV: "test" },
        windowsHide: true,
        timeout: 75_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
  } catch (error) {
    failure = error;
    result = { stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
  await writeFile(join(sandbox.logs, "regression.log"), `${result.stdout}\n${result.stderr}`, {
    flag: "wx",
  });
  await writeFile(
    join(sandbox.root, "results.json"),
    `${JSON.stringify(
      {
        exitCode: failure ? 1 : 0,
        tests: Number(/^# tests (\d+)$/m.exec(result.stdout)?.[1] ?? 0),
        passed: Number(/^# pass (\d+)$/m.exec(result.stdout)?.[1] ?? 0),
        failed: Number(/^# fail (\d+)$/m.exec(result.stdout)?.[1] ?? 0),
        logFile: "logs/regression.log",
      },
      null,
      2,
    )}\n`,
    { flag: "wx" },
  );
  if (failure)
    assert.fail(`启动准备回归失败；sandbox=${sandbox.root}\n${result.stdout}\n${result.stderr}`);
  for (const [name, count] of [
    ["tests", 57],
    ["pass", 57],
    ["fail", 0],
    ["skipped", 0],
  ]) {
    assert.match(result.stdout, new RegExp(`# ${name} ${count}\\b`));
  }
  t.diagnostic(`57/57 passed; sandbox=${sandbox.root}`);
});
