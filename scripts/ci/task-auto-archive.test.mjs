import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { runSourceTests } from "./source-test-runner.mjs";

const root = resolve(import.meta.dirname, "../..");

test("Host wires one fork archive owner and its indexed local workspace source", async () => {
  const source = await readFile(resolve(root, "packages/services/src/node.ts"), "utf8");
  assert.equal((source.match(/createTaskAutoArchiveMaintenance\s*\(/g) ?? []).length, 1);
  assert.equal((source.match(/createTaskAutoArchiveScheduler\s*\(/g) ?? []).length, 0);
  assert.match(
    source,
    /listLocalWorkspaceScopes:\s*\(\)\s*=>\s*taskIndexRepo\.listLocalWorkspaceScopes\(\)/,
  );
});

test("Host task auto archive, remote routing and Controller recovery regressions", async () => {
  // 新夹具要求项目内沙箱；CI 单独运行入口也必须自行绑定路径，不能依赖外层验证环境。
  // 共用 runner 同时清除 NODE_TEST_CONTEXT，防止嵌套 --test 跳过源测试却返回成功。
  const { stdout } = await runSourceTests([
    "packages/services/test/taskAutoArchive.test.ts",
    "packages/desktop/src/host/taskAutoArchiveRouting.test.ts",
    "packages/desktop/src/host/windowHostControllerAutoArchive.test.ts",
  ]);
  assert.match(stdout, /^# tests [1-9]\d*$/m, "Regression runner must execute real tests");
});
