import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  assertProjectPath,
  createProjectTestSandbox,
  projectRoot,
} from "./project-test-sandbox.mjs";

const run = promisify(execFile);
// 精确计数：8 项新生命周期断言 + 6 项既有 shutdown 回归，缺一即视为被削弱。
const EXPECTED_TESTS = 14;
const TEST_TIMEOUT_MS = 120_000;
const TEST_FILES = [
  "packages/services/test/terminalDynamicEventLifecycle.test.ts",
  "packages/services/test/terminalShutdown.test.ts",
];
const VITEST_CONFIG = "packages/ui/vitest.config.ts";
// 继承启动本入口的 Node，避免硬编码本机临时工具链路径，保持跨平台可运行。

/**
 * Terminal 动态事件订阅的生命周期出口回归（stale id → Event.None）。
 *
 * 隔离子进程负责完整装载与失败传播；用 Vitest 是因为被测文件与
 * terminalShutdown.test.ts 同为 vi.mock + fake PTY 形态。
 * --configLoader runner 让 Vite 在进程内处理配置，避免把配置缓存写进
 * 各包的 node_modules（项目沙箱只允许写入 .run-logs 下的本次根）。
 */
export async function runTerminalDynamicEventLifecycleTests() {
  for (const file of TEST_FILES) {
    const path = await assertProjectPath(resolve(projectRoot, file));
    assert.ok((await stat(path)).isFile(), `Test file is missing: ${file}`);
  }
  const vitestEntry = await assertProjectPath(
    resolve(projectRoot, "node_modules/vitest/vitest.mjs"),
  );
  const node = process.execPath;
  const sandbox = await createProjectTestSandbox("terminal-dynamic-event");

  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  try {
    const result = await run(
      node,
      [
        vitestEntry,
        "run",
        "--config",
        VITEST_CONFIG,
        "--configLoader",
        "runner",
        "--maxWorkers=1",
        ...TEST_FILES,
      ],
      {
        cwd: projectRoot,
        env: sandbox.env,
        windowsHide: true,
        timeout: TEST_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    stdout = error.stdout ?? "";
    stderr = error.stderr ?? "";
    exitCode = typeof error.code === "number" ? error.code : 1;
  }

  const passed = Number(/\bTests\s+(\d+) passed\b/.exec(stdout)?.[1] ?? 0);
  const failed = Number(/\bTests\s+(\d+) failed\b/.exec(stdout)?.[1] ?? 0);
  await writeFile(
    await assertProjectPath(resolve(sandbox.logs, "vitest.log")),
    `${stdout}\n${stderr}`,
    { flag: "wx" },
  );
  await writeFile(
    await assertProjectPath(resolve(sandbox.root, "results.json")),
    `${JSON.stringify({ exitCode, passed, failed })}\n`,
    { flag: "wx" },
  );
  assert.equal(
    exitCode,
    0,
    `terminal dynamic event lifecycle regression must pass (exit=${exitCode})\n${stdout}\n${stderr}`,
  );
  assert.equal(
    failed,
    0,
    `terminal dynamic event lifecycle regression reported failures\n${stdout}`,
  );
  assert.equal(
    passed,
    EXPECTED_TESTS,
    `terminal dynamic event lifecycle regression must execute exactly ${EXPECTED_TESTS} tests`,
  );
  return { passed, failed, sandboxRoot: sandbox.root };
}

test("terminal 动态事件订阅对 stale id 返回 Event.None（命令出口仍抛）", async (t) => {
  const result = await runTerminalDynamicEventLifecycleTests();
  t.diagnostic(`${result.passed} tests executed`);
});
