import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { assertProjectPath, createProjectTestSandbox } from "./project-test-sandbox.mjs";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");

export async function runSourceTests(files, { tsconfig } = {}) {
  assert.ok(files.length > 0, "A regression entrypoint must name its test files");
  // Node 的多文件发现可能忽略不存在的路径；启动前逐一核实，禁止缺文件时部分通过。
  await Promise.all(
    files.map(async (file) => {
      const path = await assertProjectPath(resolve(root, file));
      assert.ok((await stat(path)).isFile(), `Test file is missing: ${file}`);
    }),
  );
  const sandbox = await createProjectTestSandbox("source-tests");
  const env = sandbox.env;
  // 外层无隔离 runner 会在动态导入期间提前结束；独立子进程负责完整装载和失败传播。
  // NODE_TEST_CONTEXT 不能继承，否则嵌套 node:test 会跳过文件并返回成功。
  delete env.NODE_TEST_CONTEXT;
  if (tsconfig) env.TSX_TSCONFIG_PATH = await assertProjectPath(resolve(root, tsconfig));
  let result;
  let failure;
  try {
    result = await run(
      process.execPath,
      ["--import", "tsx", "--test", "--test-reporter=tap", ...files],
      { cwd: root, env, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    );
  } catch (error) {
    failure = error;
    result = { stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
  const tests = Number(/^# tests (\d+)$/m.exec(result.stdout)?.[1] ?? 0);
  const exitCode = failure
    ? typeof failure.code === "number"
      ? failure.code
      : 1
    : tests > 0
      ? 0
      : 1;
  const logPath = await assertProjectPath(join(sandbox.logs, "source-tests.log"));
  await writeFile(logPath, `${result.stdout}\n${result.stderr}`, { flag: "wx" });
  await writeFile(
    await assertProjectPath(join(sandbox.root, "results.json")),
    `${JSON.stringify({ exitCode, tests, logFile: "logs/source-tests.log" }, null, 2)}\n`,
    { flag: "wx" },
  );
  if (failure) {
    failure.sandboxRoot = sandbox.root;
    failure.logPath = logPath;
    throw failure;
  }
  assert.ok(tests > 0, "Regression runner must execute real tests");
  return { ...result, tests, sandboxRoot: sandbox.root, logPath };
}
