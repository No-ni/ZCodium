import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");

test("Host task auto archive, remote routing and Controller recovery regressions", async () => {
  // 独立进程隔离测试时钟与临时数据库；沿用现有 Release tests 自动发现入口。
  await run(
    process.execPath,
    [
      "--import",
      "tsx",
      "--test",
      "packages/services/test/taskAutoArchive.test.ts",
      "packages/desktop/src/host/taskAutoArchiveRouting.test.ts",
      "packages/desktop/src/host/windowHostControllerAutoArchive.test.ts",
    ],
    { cwd: root, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
  );
});
