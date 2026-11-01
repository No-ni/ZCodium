/**
 * UI grouped 任务视图排序 key 调用内预计算回归入口（专用 wrapper）。
 *
 * 为什么单独一条：`buildGroupedTaskViewFromSessions` 的三处排序（组成员 sortGroupTasks、
 * 顶层 missingNodes/nodes 排序）此前在比较器内重复构造派生 key——每次比较 2 次 taskKeyOf
 * （打平再 2 次 localeCompare），顶层 task 节点还重复 JSON.stringify 的 taskOrderMapKey；
 * 而 useGroupedTaskView 的 effect 以 sessionsIndexItems 为依赖，sessions-index 每个内容帧
 * 都会全量重跑 join 与排序。这条入口用真实 vitest 锁住两件事：与改动前源码（冻结 oracle）
 * 的全函数输出等价（结构化边界 + seeded 随机差分 + 输入不可变 + 引用保持），以及调用内的
 * key 构造预算（真实生产函数 + 计数 getter；修复前随机分布 256 成员实测 4,198 次）。
 *
 * 实际 IO 审查（运行前逐项核对，全部限定在当前工作树）：
 * - 被测文件是纯单元测试：被测模块是无状态纯函数，oracle 是 fixtures 下冻结的改动前源码，
 *   经 ts.transpileModule 内存装载并只注入两个真实纯计算依赖；测试只用内存合成对象。
 * - 运行目录由 scripts/ci/project-test-sandbox.mjs 绑定：HOME/USERPROFILE/APPDATA/TEMP、
 *   ZCODE_DATA_BASE_DIR/ZCODIUM_DATA_DIR/ZCODE_STORAGE_DIR/ZCODE_SESSION_DB_PATH/ZCODE_LOG_DIR
 *   全部指向项目内 `.run-logs/project-only-validation/<label>-<rand>/`（.gitignore 已忽略），
 *   并显式 `ZCODE_LOCAL_RESOURCE_MONITORING=0`。
 * - 被测算法使用内存输入；测试会读取项目内的冻结源码/manifest，并启动 Vitest。
 *   cacheDir、配置和 JSON 报告都在沙箱内；Node 白名单约束 Node 文件写入，
 *   但不能据此保证原生工具或 shell 完全隔离，也不代表整套测试无文件 IO。
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
const files = ["packages/ui/test/performanceGroupedTaskViewSortKeys.test.ts"];
// 15（新回归：fixture 哈希 1 + 结构化等价 10 + 冻结不可变 1 + seeded 差分 1 + 预算 2）。
// 精确计数防止套件被跳过。
const expectedTests = 15;

test("UI grouped 任务视图排序 key 预计算回归", async (t) => {
  for (const file of files) {
    await assertProjectPath(resolve(projectRoot, file));
  }
  const sandbox = await createProjectTestSandbox("ui-grouped-task-sort-keys");
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
