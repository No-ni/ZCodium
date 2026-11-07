import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createProjectTestSandbox, projectRoot } from "./project-test-sandbox.mjs";

test(
  "第三轮通知平台审计：实际 hook、renderer/preload 转发与 Main 展示",
  { timeout: 60_000 },
  async (t) => {
    const sandbox = await createProjectTestSandbox("notification-platform-audit");
    let result;
    try {
      result = await promisify(execFile)(
        process.execPath,
        [
          "--test",
          "--test-reporter=tap",
          join(
            import.meta.dirname,
            "fixtures/session-notification-platform-audit-runtime.test.mjs",
          ),
        ],
        {
          cwd: projectRoot,
          env: { ...sandbox.env, NODE_ENV: "test" },
          windowsHide: true,
          maxBuffer: 8 * 1024 * 1024,
        },
      );
    } catch (error) {
      result = { stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
      await writeFile(join(sandbox.logs, "audit.log"), `${result.stdout}\n${result.stderr}`);
      t.diagnostic(`evidence=${sandbox.root}`);
      assert.fail(`通知平台审计存在未满足的有效边沿：\n${result.stdout}\n${result.stderr}`);
    }
    await writeFile(join(sandbox.logs, "audit.log"), `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /# tests 18\b/);
    assert.match(result.stdout, /# pass 18\b/);
    t.diagnostic(`18/18 passed; evidence=${sandbox.root}`);
  },
);
