/**
 * UI 流式 directive 前缀探测回扫窗口回归入口（专用 wrapper）。
 *
 * 为什么单独一条：`findAssistantDirectivePrefixStart` 旧实现从正文末尾逐字符回扫全文，
 * 每个冒号都要 slice 一次剩余全文并对每个 directive 名做若干次 startsWith，累计 slice
 * 覆盖范围对正文长度平方级；流式投影（projectZCodeFileCitations /
 * projectAssistantCodeComments）在正文文本更新时重算，长回答下每次重算都要付这笔钱。
 * 这条入口用真实 vitest 锁住两件事：与旧算法（测试内冻结的 oracle）逐位等价
 * （结构化边界 + seeded 随机 + 每个流式前缀长度 + 两个投影层），以及调用内的
 * slice / startsWith 处理预算（修复前 4K/16K/64K 分别 978 / 3,920 / 15,683 次）。
 *
 * 实际 IO 审查（运行前逐项核对，全部限定在当前工作树）：
 * - 两个被测文件都是纯单元测试：被测模块是无状态纯函数，测试只用内存合成字符串，
 *   不读写文件、不联网、不触碰真实 `.zcodium` 或用户数据。
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
const files = [
  "packages/ui/test/performanceDirectivePrefixScanWindow.test.ts",
  "packages/ui/test/performanceRound26MarkdownCodeRanges.test.ts",
];
// 5（新回归：结构化等价 + 随机等价 + 流式前缀等价 + 投影层等价 + 处理预算）
// + 10（既有 round26 护栏，含 it.each 的 3 个行尾变体）。精确计数防止套件被跳过。
const expectedTests = 15;

test("UI 流式 directive 前缀探测回扫窗口回归", async (t) => {
  for (const file of files) {
    await assertProjectPath(resolve(projectRoot, file));
  }
  const sandbox = await createProjectTestSandbox("ui-directive-prefix-scan");
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
  t.diagnostic(`${passed}/${total} tests passed; sandbox=${sandbox.root}`);
  assert.ok(failed === 0, `vitest 回归存在失败：\n${failures.join("\n")}`);
  assert.ok(exitCode === 0, `vitest 退出码 ${exitCode}\n${stderr.slice(0, 4000)}`);
  assert.equal(
    total,
    expectedTests,
    `回归应执行 ${expectedTests} 项，实际 ${total}（套件可能被跳过）`,
  );
  // 每个文件都必须实际执行，不能只跑第一组就报告成功。
  for (const file of files) {
    const suite = (report.testResults ?? []).find((entry) =>
      String(entry.name ?? "").includes(file),
    );
    assert.ok(suite, `缺少套件执行记录：${file}`);
    assert.ok((suite.assertionResults ?? []).length > 0, `套件未执行任何用例：${file}`);
  }
});
