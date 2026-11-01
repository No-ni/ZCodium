/**
 * UI 助手工作项投影逐行重复转换回归入口（专用 wrapper）。
 *
 * 为什么单独一条：`buildAssistantWorkRenderItems`
 * （packages/ui/src/v4/conversationAssistantWorkItems.ts）在每次投影重算时对同一
 * toolCall 行重复执行 `toolCallRowToLegacyNode`（explore 判定一次、execute 判定一次、
 * inputStreaming/running 的 shell 等待判定再一次），并且 `isExecuteToolCall` 内部对同一
 * {kind, input} 重复解析工具身份与命令。流式期间 rows 每帧重建，这些重复推导随帧数线性
 * 累积。这条入口用真实 vitest 锁住两件事：与冻结的旧算法（测试内 oracle，含旧
 * isExecuteToolCall 内联推导）逐项等价，以及调用内的 legacy 转换 / 身份解析预算
 * （修复前实测转换约为 toolCall 行数的 2~3 倍、身份解析约为 3 倍）。
 *
 * 实际 IO 审查（运行前逐项核对，全部限定在当前工作树）：
 * - 被测模块是纯投影函数：输入合成 ConversationRow、输出渲染项，不读写文件、不联网、
 *   不触碰真实 `.zcodium` 或用户数据；spy 只统计模块内纯函数调用次数。
 * - 运行目录由 scripts/ci/project-test-sandbox.mjs 绑定：HOME/USERPROFILE/APPDATA/TEMP、
 *   ZCODE_DATA_BASE_DIR/ZCODIUM_DATA_DIR/ZCODE_STORAGE_DIR/ZCODE_SESSION_DB_PATH/ZCODE_LOG_DIR
 *   全部指向项目内 `.run-logs/project-only-validation/<label>-<rand>/`（.gitignore 已忽略），
 *   并显式 `ZCODE_LOCAL_RESOURCE_MONITORING=0`。
 * - 子进程仅 vitest 本身；NODE_OPTIONS 的 `--allow-fs-write` 白名单只含该沙箱根，
 *   cacheDir 与 JSON 报告都写在沙箱内，越界写入会被 Node permission 直接拒绝。
 *   vitest 配置文件同样写在沙箱根内，不修改仓库中的任何现有配置。
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
const files = ["packages/ui/test/performanceAssistantWorkRowConversion.test.ts"];
// 精确计数防止套件被跳过（结构化等价 10 + seeded 随机等价 2 + 转换预算 1 + 身份解析预算 1）。
const expectedTests = 14;

test("UI 助手工作项投影逐行重复转换回归", async (t) => {
  for (const file of files) {
    await assertProjectPath(resolve(projectRoot, file));
  }
  const sandbox = await createProjectTestSandbox("ui-assistant-work-row-conversion");
  const config = join(sandbox.root, "vitest.config.mjs");
  await writeFile(
    config,
    `export default ${JSON.stringify(
      {
        root: projectRoot,
        cacheDir: join(sandbox.cache, "vitest"),
        resolve: { alias: { "@": join(projectRoot, "packages/ui/src") } },
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
  t.diagnostic(`${passed}/${total} tests passed; sandbox=${sandbox.root}`);
  assert.ok(failed === 0, `vitest 回归存在失败：\n${failures.join("\n")}`);
  assert.ok(exitCode === 0, `vitest 退出码 ${exitCode}\n${stderr.slice(0, 4000)}`);
  assert.equal(
    total,
    expectedTests,
    `回归应执行 ${expectedTests} 项，实际 ${total}（套件可能被跳过）`,
  );
  for (const file of files) {
    const suite = (report.testResults ?? []).find((entry) =>
      String(entry.name ?? "").includes(file),
    );
    assert.ok(suite, `缺少套件执行记录：${file}`);
    assert.ok((suite.assertionResults ?? []).length > 0, `套件未执行任何用例：${file}`);
  }
});
