/**
 * UI 文件树搜索展开平方级扫描回归入口（专用 wrapper）。
 *
 * 为什么单独一条：`filterWorkspaceFileTreeRows` 的搜索展开阶段曾对每个未命中行全表扫描
 * 命中行/命中目录（rows × matches 平方级），而文件树搜索按 `fileSearchQuery` 逐字符整树重算。
 * 这条入口用真实 vitest 锁住两件事：与旧算法的行为等价（结构化边界 + seeded 随机树），
 * 以及调用内的字符串比较工作量预算（修复前约 56 万/75 万次，预算 64 × rows）。
 *
 * 实际 IO 审查（运行前逐项核对，全部限定在当前工作树）：
 * - 三个被测文件都是纯单元测试：model.ts 是无状态纯函数；differential 测试只读同目录
 *   fixtures/performance-audit-baseline 下冻结的审计源码，并用内存依赖装载，不执行 IO。
 * - 运行目录由 scripts/ci/project-test-sandbox.mjs 绑定：HOME/USERPROFILE/APPDATA/TEMP、
 *   ZCODE_DATA_BASE_DIR/ZCODIUM_DATA_DIR/ZCODE_STORAGE_DIR/ZCODE_SESSION_DB_PATH/ZCODE_LOG_DIR
 *   全部指向项目内 `.run-logs/project-only-validation/<label>-<rand>/`（.gitignore 已忽略），
 *   不触碰真实 `.zcodium` 或任何用户数据；并显式 `ZCODE_LOCAL_RESOURCE_MONITORING=0`。
 * - 子进程仅 vitest 本身；NODE_OPTIONS 的 `--allow-fs-write` 白名单只含该沙箱根，
 *   cacheDir 与 JSON 报告都写在沙箱内，越界写入会被 Node permission 直接拒绝。
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
  "packages/ui/test/performanceFileTreeSearchExpansion.test.ts",
  "packages/ui/test/performanceFileTreeChangedFilter.test.ts",
  "packages/ui/test/performanceAuditDifferential.test.ts",
];
// 9（新回归：等价 7 + 预算 2）+ 4（changedFilter）+ 5（differential）。精确计数防止套件被跳过。
const expectedTests = 18;

test("UI 文件树搜索展开线性化回归", async (t) => {
  for (const file of files) {
    await assertProjectPath(resolve(projectRoot, file));
  }
  const sandbox = await createProjectTestSandbox("ui-file-tree-search-expansion");
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
