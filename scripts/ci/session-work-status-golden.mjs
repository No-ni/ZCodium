import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  assertProjectPath,
  createProjectTestSandbox,
  projectRoot,
} from "./project-test-sandbox.mjs";

// 这组旧黄金测试只消费内存事件/消息与 fake Host/App；不启动 Agent、不创建持久库。
// Vitest 缓存、配置、报告及所有子进程环境目录均约束在项目沙箱。
const files = [
  "apps/zcode-cli/packages/bootstrap/tests/sessions-index-projection.test.ts",
  "apps/zcode-cli/packages/bootstrap/tests/product-projection.test.ts",
  "apps/zcode-cli/packages/bootstrap/tests/product-projection-streaming-actions.test.ts",
  "apps/zcode-cli/packages/bootstrap/tests/transcript-hydration.test.ts",
  "apps/zcode-cli/packages/bootstrap/tests/v4-native-queue.test.ts",
];
for (const file of files) await assertProjectPath(join(projectRoot, file));
const sandbox = await createProjectTestSandbox("session-work-status-golden");
const config = join(sandbox.root, "vitest.config.mjs");
const reportPath = join(sandbox.root, "vitest-report.json");
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
let output;
let exitCode = 0;
try {
  output = await promisify(execFile)(
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
} catch (error) {
  exitCode = typeof error.code === "number" ? error.code : 1;
  output = { stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
}
await writeFile(join(sandbox.logs, "vitest.log"), `${output.stdout}\n${output.stderr}`, {
  flag: "wx",
});
const report = JSON.parse(await readFile(reportPath, "utf8"));
await writeFile(
  join(sandbox.root, "results.json"),
  `${JSON.stringify({ exitCode, tests: report.numTotalTests, passed: report.numPassedTests, failed: report.numFailedTests, files }, null, 2)}\n`,
  { flag: "wx" },
);
console.log(
  `Golden regression: ${report.numPassedTests}/${report.numTotalTests}; exit=${exitCode}; sandbox=${sandbox.root}`,
);
for (const suite of report.testResults) {
  for (const assertion of suite.assertionResults) {
    if (assertion.status !== "failed") continue;
    console.log(`${assertion.fullName}\n${assertion.failureMessages.join("\n")}`);
  }
}
assert.ok(report.numTotalTests > 0, "Golden regression must execute real tests");
assert.equal(report.numPendingTests, 0, "Golden regression must not skip tests");
assert.equal(report.numFailedTests, 0, "Golden regression assertions must pass");
assert.equal(exitCode, 0, "Golden regression runner must finish successfully");
