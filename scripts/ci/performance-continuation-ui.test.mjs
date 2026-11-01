/**
 * UI token 数字格式化重复构造回归入口（专用 wrapper）。
 *
 * 为什么单独一条：`packages/ui/src/lib/tokenNumberFormat.ts` 的导出函数每次调用都
 * `new Intl.NumberFormat`，等于每次重新解析 locale/选项再构造格式化器；该函数被用量
 * 统计表逐格、上下文工具栏逐段、模型卡片 badge 等渲染路径反复调用，构造次数与调用次数
 * 线性放大。这条入口用真实 vitest 锁住两件事：与旧实现（测试内冻结 oracle）输出逐位
 * 等价（结构化边界 + 伪随机语料 + 固定 en-US 标签），以及一次 6000 次格式化负载内的
 * formatter 构造次数预算（修复前 6000 次，修复后按互异配置收敛到 4 次）。
 *
 * 实际 IO 审查（运行前逐项核对，全部限定在当前工作树）：
 * - 被测模块是纯计算函数（Intl 格式化），测试只用内存合成数值，不读写文件、不联网、
 *   不触碰真实 `.zcodium` 或用户数据；vitest 转译读取均在仓库源码内。
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
const files = ["packages/ui/test/performanceTokenNumberFormatterCache.test.ts"];
// 6（oracle 语料等价 + 模型容量标签等价 + NUL 键碰撞守卫 + 非法 locale/小数位异常 parity
// + 构造次数预算 + 有界缓存 FIFO 淘汰构造计数）。精确计数防止套件被跳过。
const expectedTests = 6;

test("UI token 数字格式化重复构造回归", async (t) => {
  for (const file of files) {
    await assertProjectPath(resolve(projectRoot, file));
  }
  const sandbox = await createProjectTestSandbox("performance-continuation-ui");
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
  assert.equal(Number(report.numPendingTests ?? 0), 0, "回归不能包含跳过的用例");
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
  for (const file of files) {
    const suite = (report.testResults ?? []).find((entry) =>
      String(entry.name ?? "").includes(file),
    );
    assert.ok(suite, `缺少套件执行记录：${file}`);
    assert.ok((suite.assertionResults ?? []).length > 0, `套件未执行任何用例：${file}`);
  }
});
