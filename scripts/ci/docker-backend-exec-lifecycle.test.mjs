/**
 * Docker 远端 backend exec 进程生命周期回归入口（专用 wrapper）。
 *
 * 背景：docker-backend 的 dispose() 过去是空实现，而 exec() 会 spawn 长驻
 * `docker exec` 子进程（connectRemote 的远端 server 与 upload 的 cat 管道都走它）。
 * 断开/退出后这些子进程无人回收，每次远程会话结束泄漏一个宿主进程。本入口用
 * fake ChildProcess 锁住所有权语义，不启动真实 Docker。
 *
 * 实际 IO 审查（运行前逐项核对，全部限定在当前工作树）：
 * - 被测文件用 vi.mock 替换 node:child_process 的 spawn/execFile 与 docker-detect，
 *   不执行任何 docker 命令、不联网、不读写真实 .zcodium 数据。
 * - 运行目录由 scripts/ci/project-test-sandbox.mjs 绑定：HOME/USERPROFILE/APPDATA/TEMP、
 *   ZCODE_DATA_BASE_DIR/ZCODIUM_DATA_DIR/ZCODE_STORAGE_DIR/ZCODE_SESSION_DB_PATH/ZCODE_LOG_DIR
 *   全部指向项目内 .run-logs/project-only-validation/<label>-<rand>/（.gitignore 已忽略）。
 * - 子进程仅 vitest 本身；NODE_OPTIONS 的 --allow-fs-write 白名单只含该沙箱根。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  assertProjectPath,
  createProjectTestSandbox,
  projectRoot,
} from "./project-test-sandbox.mjs";

const run = promisify(execFile);
const files = ["packages/server/src/remote/docker-backend-exec-lifecycle.test.ts"];
// 完整 14 项：正常自退不 kill、宽限内退出不 kill、宽限后 kill（多 child 各一次且不发起新命令）、
// spawn 失败摘除、alive error 保留所有权仍被清理、关闭期间迟到 exec 不 spawn、
// dispose 后新 exec 拒绝、重复 dispose/disposeAndWait 幂等、stdio/onClose 保留、
// upload 的 exec 产物登记并被回收、graceTimeoutMs:0 立即 kill、
// killWaitTimeoutMs:0 有界返回且保留所有权、stdin.end() 同步回调重入返回同一 promise 且 kill 一次、
// 等待内部未知异常（setTimeout 故障）向 disposeAndWait 调用方原样传播。
// 计数与状态严格相等：少于 14 说明套件被跳过，多于 14 说明有人静默加用例，
// 出现 pending/todo 或非 passed 用例状态都必须失败。
const expectedTests = 14;

test("Docker backend exec 进程所有权回归", async (t) => {
  for (const file of files) {
    await assertProjectPath(resolve(projectRoot, file));
  }
  const sandbox = await createProjectTestSandbox("docker-exec-lifecycle");
  const config = join(sandbox.root, "vitest.config.mjs");
  await writeFile(
    config,
    `export default ${JSON.stringify(
      {
        root: projectRoot,
        cacheDir: join(sandbox.cache, "vitest"),
        test: {
          include: files,
          cache: false,
          fileParallelism: false,
          maxWorkers: 1,
          environment: "node",
        },
      },
      null,
      2,
    )};\n`,
    { flag: "wx" },
  );
  const reportPath = join(sandbox.root, "vitest-report.json");
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  try {
    const output = await run(
      process.execPath,
      [
        join(projectRoot, "node_modules/vitest/vitest.mjs"),
        "run",
        "--config",
        config,
        "--configLoader",
        "native",
        "--reporter",
        "json",
        "--outputFile",
        reportPath,
      ],
      { cwd: projectRoot, env: sandbox.env, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
    );
    stdout = output.stdout;
    stderr = output.stderr;
  } catch (error) {
    exitCode = typeof error.code === "number" ? error.code : 1;
    stdout = error.stdout ?? "";
    stderr = error.stderr ?? "";
  }
  await writeFile(join(sandbox.logs, "vitest.log"), `${stdout}\n${stderr}`, { flag: "wx" });
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const passed = Number(report.numPassedTests ?? 0);
  const failed = Number(report.numFailedTests ?? 0);
  const pending = Number(report.numPendingTests ?? 0);
  const todo = Number(report.numTodoTests ?? 0);
  const total = passed + failed;
  const caseStatuses = (report.testResults ?? [])
    .flatMap((suite) => suite.assertionResults ?? [])
    .map((entry) => entry.status);
  await writeFile(
    join(sandbox.root, "results.json"),
    `${JSON.stringify({ exitCode, passed, failed, pending, todo, files }, null, 2)}\n`,
    { flag: "wx" },
  );
  const failures = [
    ...(report.testResults ?? [])
      .flatMap((suite) => suite.assertionResults ?? [])
      .filter((entry) => entry.status === "failed")
      .map((entry) => `${entry.title}: ${(entry.failureMessages ?? []).join("\n")}`),
    ...(report.testResults ?? [])
      .filter((suite) => suite.status === "failed" && (suite.assertionResults ?? []).length === 0)
      .map((suite) => `${suite.name}: ${suite.message}`),
  ];
  t.diagnostic(
    `vitest pass=${passed} fail=${failed} exit=${exitCode} sandbox=${sandbox.root}\n${failures.join("\n")}`,
  );
  assert.equal(
    total,
    expectedTests,
    `回归必须完整执行 ${expectedTests} 项测试，实际 ${total} 项；${failures.join(" | ").slice(0, 1500)}`,
  );
  assert.equal(passed, expectedTests, `回归必须 ${expectedTests} 项全部 passed，实际 ${passed} 项`);
  assert.equal(pending, 0, `回归不允许 pending 用例，实际 ${pending} 项`);
  assert.equal(todo, 0, `回归不允许 todo 用例，实际 ${todo} 项`);
  assert.deepEqual(
    caseStatuses,
    Array.from({ length: expectedTests }, () => "passed"),
    `每个用例状态都必须为 passed，实际 ${JSON.stringify(caseStatuses)}`,
  );
  assert.equal(failed, 0, "Docker exec 进程所有权回归必须全部通过");
  assert.equal(exitCode, 0, "vitest 子进程退出码必须为 0");
});
