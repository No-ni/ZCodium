import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");

export async function runSourceTests(files, { tsconfig } = {}) {
  assert.ok(files.length > 0, "A regression entrypoint must name its test files");
  // Node 的多文件发现可能忽略不存在的路径；启动前逐一核实，禁止缺文件时部分通过。
  await Promise.all(
    files.map(async (file) => {
      assert.ok((await stat(resolve(root, file))).isFile(), `Test file is missing: ${file}`);
    }),
  );
  const env = { ...process.env };
  // 外层无隔离 runner 会在动态导入期间提前结束；独立子进程负责完整装载和失败传播。
  // NODE_TEST_CONTEXT 不能继承，否则嵌套 node:test 会跳过文件并返回成功。
  delete env.NODE_TEST_CONTEXT;
  if (tsconfig) env.TSX_TSCONFIG_PATH = resolve(root, tsconfig);
  const result = await run(
    process.execPath,
    ["--import", "tsx", "--test", "--test-reporter=tap", ...files],
    { cwd: root, env, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
  );
  const tests = Number(/^# tests (\d+)$/m.exec(result.stdout)?.[1] ?? 0);
  assert.ok(tests > 0, "Regression runner must execute real tests");
  return { ...result, tests };
}
