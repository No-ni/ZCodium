/**
 * 首启 discovery 陈旧回包边界回归入口（专用 wrapper）。
 *
 * 为什么单独一条：useSettingsSync 的首启 effect 只防护了 getFirstRunPromptState 一个 await，
 * 之后 `await loadDiscovery()` 把取消边界关在函数外；detect 在途时切换 workspace（或卸载），
 * 旧 scope 的回包会继续提交——非空回包用旧 agents 打开引导弹窗、空回包调用 app 级
 * markFirstRunPromptHandled 吞掉新 workspace 的首启提示、失败回包用旧错误打开弹窗。
 * 这条入口用真实 React（react-reconciler 内存渲染器）驱动真实 hook 锁住该边界。
 *
 * 实际 IO 审查（运行前逐项核对，全部限定在当前工作树）：
 * - 被测 hook 的依赖（useServices / useZCodeSessionService / zcodeDraftSkillInvalidation /
 *   logger）在测试内 mock；hook 本体、React、react-reconciler 均为仓库既有真实模块。
 * - react 与 react-reconciler 经 createRequire 从仓库 node_modules 装载（react-reconciler
 *   0.33.0 是仓库现有传递依赖，peer react ^19.2.0，与已装 react 19.2.7 匹配）；
 *   不新增、不改动任何 package.json 依赖，不访问网络。
 * - 渲染器是纯内存实现：host 面全部置空、用例组件返回 null，无 DOM、无文件 IO、无子进程。
 * - 运行目录由 scripts/ci/project-test-sandbox.mjs 绑定：HOME/USERPROFILE/APPDATA/TEMP、
 *   ZCODE_DATA_BASE_DIR/ZCODIUM_DATA_DIR/ZCODE_STORAGE_DIR/ZCODE_SESSION_DB_PATH/ZCODE_LOG_DIR
 *   全部指向项目内 `.run-logs/project-only-validation/<label>-<rand>/`（.gitignore 已忽略）。
 * - vitest 配置文件写在沙箱根内（root 仍为仓库根以解析 @ 别名），不修改仓库任何现有配置；
 *   cacheDir、JSON 报告都在沙箱内。Node 白名单约束 Node 文件写入，但不代表整套测试无文件 IO。
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
const files = ["packages/ui/src/hooks/useSettingsSync.test.ts"];
// 9 项：旧非空不覆盖 / 旧空不标记不重置 / 旧 reject 不开错误态 / identity-only 同 path 切换 /
// 卸载后无 late mark / 正常首启与入参保持 / handled 路径 / manual reopen 空结果仍 open /
// mark 在途期间切换：有效 mark 恰好一次且旧 await 后 reset 不覆盖新 dialog。
const expectedTests = 9;

test("首启 discovery 陈旧回包边界回归", async (t) => {
  for (const file of files) {
    await assertProjectPath(resolve(projectRoot, file));
  }
  const sandbox = await createProjectTestSandbox("settings-sync-discovery-lifecycle");
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
  const pending = Number(report.numPendingTests ?? 0);
  const todo = Number(report.numTodoTests ?? 0);
  const statuses = (report.testResults ?? [])
    .flatMap((suite) => suite.assertionResults ?? [])
    .map((entry) => entry.status);
  t.diagnostic(`${passed}/${total} tests passed; sandbox=${sandbox.root}`);
  assert.ok(failed === 0, `vitest 回归存在失败：\n${failures.join("\n")}`);
  assert.ok(exitCode === 0, `vitest 退出码 ${exitCode}\n${stderr.slice(0, 4000)}`);
  // 严格口径：总数、通过数、无 skip/pending/todo、逐用例状态都必须精确命中，防止套件被跳过
  // 或用例被降级成 skipped/pending 后仍被报告成通过。
  assert.equal(
    total,
    expectedTests,
    `回归应执行 ${expectedTests} 项，实际 ${total}（套件可能被跳过）`,
  );
  assert.equal(passed, expectedTests, `回归应通过 ${expectedTests} 项，实际通过 ${passed}`);
  assert.equal(pending + todo, 0, `回归存在 skip/pending/todo：pending=${pending} todo=${todo}`);
  assert.deepEqual(
    [...new Set(statuses)],
    ["passed"],
    `存在非 passed 状态的用例：${JSON.stringify(statuses)}`,
  );
  for (const file of files) {
    const suite = (report.testResults ?? []).find((entry) =>
      String(entry.name ?? "").includes(file),
    );
    assert.ok(suite, `缺少套件执行记录：${file}`);
    assert.ok((suite.assertionResults ?? []).length > 0, `套件未执行任何用例：${file}`);
  }
});
