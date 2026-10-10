import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
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
  assert.match(result.stdout, /Tests\s+42 passed/);
  t.diagnostic("42 tests executed");
});
