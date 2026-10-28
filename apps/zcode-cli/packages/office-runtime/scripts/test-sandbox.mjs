import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertProjectPath,
  createProjectTestSandbox,
} from "../../../../../scripts/ci/project-test-sandbox.mjs";

// runner 装载避免 Vite 在包根写临时配置；测试写入只能使用中央沙箱白名单。
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(packageRoot, "package.json"));
const vitestEntry = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs");

const sandbox = await createProjectTestSandbox("office-vitest");
const cacheDir = await assertProjectPath(join(sandbox.root, "vite-cache"));
const resultsPath = await assertProjectPath(join(sandbox.root, "vitest-results.json"));
console.log(`[office:test] project sandbox: ${sandbox.root}`);
const child = spawn(
  process.execPath,
  [
    vitestEntry,
    "run",
    "--configLoader=runner",
    "--reporter=default",
    "--reporter=json",
    `--outputFile.json=${resultsPath}`,
  ],
  {
    cwd: packageRoot,
    env: { ...sandbox.env, VITEST_CACHE_DIR: cacheDir },
    stdio: "inherit",
    windowsHide: true,
  },
);
child.once("error", (error) => {
  console.error(`[office:test] failed to launch vitest: ${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});
