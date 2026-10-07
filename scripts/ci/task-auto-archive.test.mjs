import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");

test("Host task auto archive, remote routing and Controller recovery regressions", async () => {
  // 独立进程隔离测试时钟与临时数据库；沿用现有 Release tests 自动发现入口。
  // node:test 会把该标记传给子进程，嵌套 --test 随即跳过全部文件却返回成功，必须移除。
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const { stdout } = await run(
    process.execPath,
    [
      "--import",
      "tsx",
      "--test",
      "--test-reporter=tap",
      "packages/services/test/taskAutoArchive.test.ts",
      "packages/desktop/src/host/taskAutoArchiveRouting.test.ts",
      "packages/desktop/src/host/windowHostControllerAutoArchive.test.ts",
    ],
    { cwd: root, env, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
  );
  assert.match(stdout, /^# tests [1-9]\d*$/m, "Regression runner must execute real tests");
});
