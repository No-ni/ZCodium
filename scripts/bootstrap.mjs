#!/usr/bin/env node

import process from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "./spawn-command.mjs";
import { clearHoistedPatchedDependencyTargets } from "./bootstrap-patched-dependencies.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "..");
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function runPnpm(args) {
  runCommand(pnpmCommand, args, {
    cwd: rootDir,
    env: process.env,
  });
}

runCommand("git", ["submodule", "update", "--init", "--recursive", "apps/zcode-cli"], {
  cwd: rootDir,
  env: process.env,
});

// 吸收上游修复：pnpm hoisted 布局下 patchedDependencies 的目标可能残留未打补丁的旧副本，
// install 前先清掉这些落点，让 pnpm 重新铺补丁版本，避免 node_modules 与补丁漂移。
const clearedPatchedDependencies = await clearHoistedPatchedDependencyTargets({
  rootDir,
  packageJsonPath: resolve(rootDir, "package.json"),
});
if (clearedPatchedDependencies.length > 0) {
  console.log(
    `[bootstrap] refreshed hoisted patched dependencies: ${clearedPatchedDependencies.join(", ")}`,
  );
}

runPnpm(["install"]);
runPnpm(["prepare:desktop-runtime"]);
runPnpm(["run", "build:bootstrap"]);
