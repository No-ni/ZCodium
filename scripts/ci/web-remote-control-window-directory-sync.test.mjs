/**
 * Web 远控「窗口目录投影」回归入口（专用 wrapper）。
 *
 * 为什么单独一条：`SyncWebRemoteControlWorkspaces` 里必选的手机清单写入与可选的窗口目录投影
 * 共用一个同步入口，两者顺序一旦回退（严格投影校验先抛），清单同步会被静默跳过、手机端停在旧列表。
 * 这条入口用真实 vitest 断言锁住顺序，防止后续改动把耦合改回去。
 *
 * 实际 IO 审查（运行前逐项核对，全部限定在当前工作树）：
 * - 被测文件 packages/desktop/src/main/webRemoteControl/ipc.test.ts 用 `vi.mock("electron")` 只替换
 *   `ipcMain.handle`，不装载 Electron 运行时、不创建窗口、不启动进程。
 * - ipc.ts 对 `./manager.js` 与 `./logger.js` 都是 `import type`（编译期擦除），因此不会拉起
 *   relay/网络侧；`getManager()` 由测试注入纯内存 spy。载荷校验来自 `@zcode/shared` 的纯 zod schema。
 * - 运行目录由 scripts/ci/project-test-sandbox.mjs 绑定：HOME/USERPROFILE/APPDATA/TEMP、
 *   ZCODE_DATA_BASE_DIR/ZCODIUM_DATA_DIR/ZCODE_STORAGE_DIR/ZCODE_SESSION_DB_PATH/ZCODE_LOG_DIR 全部
 *   指向项目内 `.run-logs/project-only-validation/<label>-<rand>/`（.gitignore 已忽略），不触碰真实
 *   `.zcodium` 或任何用户数据；并显式 `ZCODE_LOCAL_RESOURCE_MONITORING=0`。
 * - 子进程仅 vitest 本身；NODE_OPTIONS 的 `--allow-fs-write` 白名单只含该沙箱根，cacheDir 与 JSON 报告
 *   都写在沙箱内，越界写入会被 Node permission 直接拒绝。
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
const files = ["packages/desktop/src/main/webRemoteControl/ipc.test.ts"];
// 4 项：合法投影单调代际、无 Host 不投递、旧「key 与身份不符」拒绝、legacy remoteSessionId 缺
// identity 时必选清单仍先行写入。少于该数量说明套件被跳过而不是通过。
const expectedTests = 4;

test("Web 远控窗口目录投影顺序回归", async (t) => {
  for (const file of files) {
    await assertProjectPath(resolve(projectRoot, file));
  }
  const sandbox = await createProjectTestSandbox("window-directory-sync");
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
    // 用例级失败
    ...(report.testResults ?? [])
      .flatMap((suite) => suite.assertionResults ?? [])
      .filter((entry) => entry.status === "failed")
      .map((entry) => `${entry.title}: ${(entry.failureMessages ?? []).join("\n")}`),
    // 套件级失败（装载/转译失败时 assertionResults 为空，只在这里可见，不能当成 0 项通过放过）
    ...(report.testResults ?? [])
      .filter((suite) => suite.status === "failed" && (suite.assertionResults ?? []).length === 0)
      .map((suite) => `${suite.name}: ${suite.message}`),
  ];
  t.diagnostic(
    `vitest pass=${passed} fail=${failed} exit=${exitCode} sandbox=${sandbox.root}\n${failures.join("\n")}`,
  );
  assert.ok(
    total >= expectedTests,
    `回归必须执行至少 ${expectedTests} 项测试，实际 ${total} 项；${failures.join(" | ").slice(0, 1500)}`,
  );
  assert.equal(failed, 0, "窗口目录投影顺序回归必须全部通过");
  assert.equal(exitCode, 0, "vitest 子进程退出码必须为 0");
});
