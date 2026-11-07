import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createProjectTestSandbox, projectRoot } from "./project-test-sandbox.mjs";

test("WSC01-04：真实浏览器会话工作时长连续性", { timeout: 120_000 }, async (t) => {
  const sandbox = await createProjectTestSandbox("session-work-duration-browser");
  let output;
  try {
    output = await promisify(execFile)(
      process.execPath,
      [join(import.meta.dirname, "fixtures/session-work-duration-browser.mjs")],
      {
        cwd: projectRoot,
        env: sandbox.env,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        timeout: 105_000,
      },
    );
  } catch (error) {
    await writeFile(
      join(sandbox.logs, "browser.log"),
      `${error.stdout ?? ""}\n${error.stderr ?? ""}`,
    );
    assert.fail(
      `计时浏览器回归失败；${sandbox.root}\n${error.stdout ?? ""}\n${error.stderr ?? ""}`,
    );
  }
  await writeFile(join(sandbox.logs, "browser.log"), `${output.stdout}\n${output.stderr}`);
  assert.match(output.stdout, /WSC01-04: 8 variants passed/);
  t.diagnostic(`8 variants passed; sandbox=${sandbox.root}`);
});
