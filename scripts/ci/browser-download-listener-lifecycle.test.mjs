/**
 * 内置浏览器下载监听生命周期回归入口（专用 wrapper）。
 *
 * 背景：will-download 监听挂在 guest.session（全部内置浏览器 tab 共享的持久
 * partition persist:zcode-embedded-browser）上，不随 guest（WebContents）销毁而释放。
 * detachGuest 过去在 guest 已销毁时跳过 downloadCleanup，监听随 tab 崩溃/换代/换壳
 * 线性累积。本入口用生产 BrowserGuestManager + fake Electron 锁住摘除语义。
 *
 * 实际 IO 审查（运行前逐项核对，全部限定在当前工作树）：
 * - 被测文件用 vi.mock("electron") 只提供 webContents.fromId；guest/session/download item
 *   均为内存 EventEmitter，不装载 Electron 运行时、不创建窗口、不启动浏览器。
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
const files = ["packages/desktop/src/main/browserView/browserGuestManagerLifecycle.test.ts"];
// 既有 6 项（destroyed listener ownership / CDP crash guard / viewport 读取中途关闭）
// + 新增 7 项（共享 session 下载监听所有权）。少于该数量说明套件被跳过而不是通过。
const expectedTests = 13;

test("内置浏览器下载监听生命周期回归", async (t) => {
  for (const file of files) {
    await assertProjectPath(resolve(projectRoot, file));
  }
  const sandbox = await createProjectTestSandbox("browser-download-listener");
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
  const total = passed + failed;
  await writeFile(
    join(sandbox.root, "results.json"),
    `${JSON.stringify({ exitCode, passed, failed, files }, null, 2)}\n`,
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
  assert.equal(total, expectedTests, `回归必须执行完整 ${expectedTests} 项测试`);
  assert.equal(passed, expectedTests, "不能以跳过用例代替通过");
  assert.equal(failed, 0, "下载监听生命周期回归必须全部通过");
  assert.equal(exitCode, 0, "vitest 子进程退出码必须为 0");
});
