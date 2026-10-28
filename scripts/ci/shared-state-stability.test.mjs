import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify, stripVTControlCharacters } from "node:util";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("插件泳道和共享 JSON 文件跨进程回归", async (t) => {
  const result = await runSourceTests([
    "packages/services/test/cliLaneIdleReclaim.test.ts",
    "packages/services/test/sharedJsonFileLock.test.ts",
  ]);
  assert.equal(result.tests, 6);
  t.diagnostic(`${result.tests} tests executed`);
});

test("SSH 信任记录与 Main/Host MCP 迁移回归", async (t) => {
  const root = resolve(import.meta.dirname, "../..");
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = await promisify(execFile)(
    process.execPath,
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      "packages/server/src/remote/sshKnownHosts.test.ts",
      "packages/server/src/remote/sshBackendHostKey.test.ts",
      "packages/server/src/remote/sshHostVerificationLifecycle.test.ts",
      "packages/services/test/mcpLegacyMigration.test.ts",
      "packages/services/test/sharedConfigMutations.test.ts",
    ],
    { cwd: root, env, timeout: 60_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
  );
  // CI 的 vitest 输出带 ANSI 颜色码（本地 NO_COLOR/TERM=dumb 时不带），
  // 先剥离控制序列；精确条数会因新增回归误报，保留最低覆盖数并由子进程失败码收口。
  const tests = Number(/Tests\s+(\d+) passed/.exec(stripVTControlCharacters(result.stdout))?.[1]);
  assert.ok(tests >= 42, "共享状态回归至少执行原有 42 项测试");
  t.diagnostic(`${tests} tests executed`);
});
