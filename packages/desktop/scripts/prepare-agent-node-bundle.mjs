#!/usr/bin/env node
import {
  BUILTIN_PLUGIN_ASSETS,
  BUILTIN_OFFICE_PLUGIN_BUILD_SCRIPT,
  BUILTIN_PLUGIN_TOP_LEVEL_PATHS,
} from "@zcode/shared/builtin-plugin-assets";

// 桌面打包态的 agent 运行时资产：把 agent 的 JS bundle（zcode.cjs）放进 bundled-agents/<platform>/glm，
// 由 app 内置的 Electron Node runtime（ELECTRON_RUN_AS_NODE）执行，替代以前随包内置的独立 Node 二进制。
//
// 为什么这么做：
// - Agent 主入口为 JS；独立 node_repl 宿主另携带目标平台 CUA N-API 库；
// - Electron 41 内置 Node 24.x，与 zcode-cli 的目标运行时一致；
// - 单平台体积从 ~180MB 降到 ~16MB，且同一份 JS 跨平台通用；
// - app-server 命令路径不会加载 @zcode/tui，所以这里天然不打包 TUI。
//
// 此入口只准备本机 Agent；本 fork 不随桌面包构建 Linux 远端运行资源。

import { existsSync } from "node:fs";
import { access, cp, mkdir, rm, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runCommand } from "../../../scripts/spawn-command.mjs";
import { validateBuiltinPluginAssets } from "../../../scripts/builtin-plugin-assets.mjs";
import { stageCuaDriverRuntime } from "../../../scripts/cua-driver-runtime-assets.mjs";
import { stageAgentBundle } from "./stage-agent-bundle.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const cliBundlePath = resolve(repoRoot, "apps/zcode-cli/packages/cli/dist/zcode.cjs");
const pnpmRunEnv = {
  ...process.env,
  // pnpm 11 会在 apps/zcode-cli 子 workspace 执行 run 前触发 install；
  // 子 workspace 不能解析根 workspace 的 @zcode/shared，Docker/web app 打包会因此卡在插件 runtime 构建。
  PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
};
const BROWSER_USE_PLUGIN_PACKAGE_NAME = "@zcode/browser-use-plugin";

// 平台目录命名：darwin/win32/linux + x64/arm64，
// 支持 ZCODE_TARGET_OS / ZCODE_TARGET_ARCH 覆盖（交叉打包时由 CI 注入）。
function normalizePlatform(raw) {
  switch (raw) {
    case "mac":
    case "macos":
    case "darwin":
    case "osx":
      return "darwin";
    case "win":
    case "windows":
    case "win32":
      return "win32";
    case "linux":
      return "linux";
    default:
      return raw;
  }
}

function normalizeArch(raw) {
  switch (raw) {
    case "x86_64":
    case "x64":
    case "amd64":
      return "x64";
    case "aarch64":
    case "arm64":
      return "arm64";
    default:
      return raw;
  }
}

const platform = normalizePlatform(process.env.ZCODE_TARGET_OS || "") || process.platform;
const arch = normalizeArch(process.env.ZCODE_TARGET_ARCH || "") || process.arch;
const platformKey = `${platform}-${arch}`;

const glmDir = resolve(desktopRoot, "bundled-agents", platformKey, "glm");
const officialPluginPackages = BUILTIN_PLUGIN_ASSETS;
// 随 CLI 内置的技能包（不是插件）：bootstrap 的 resolveBundledSkillRoots 沿官方插件同款候选目录
// 在 zcode.cjs 旁找 packages/bundled-skills 并原地读取。漏 stage 它，桌面包的 /workflow 会展开成
// 「先加载 dynamic-workflows 技能」而技能文件不存在，因此必须随 Agent 一起打包。
const bundledSkillPack = {
  relativePath: "apps/zcode-cli/packages/bundled-skills",
  requiredPaths: [
    "skills/dynamic-workflows/SKILL.md",
    "skills/dynamic-workflows/patterns.md",
    "skills/dynamic-workflows/examples.md",
  ],
  stagedPath: "packages/bundled-skills",
  topLevelPaths: ["skills"],
};
const includedOfficialPluginTopLevelPaths = new Set(BUILTIN_PLUGIN_TOP_LEVEL_PATHS);
const excludedOfficialPluginAssetNames = new Set([
  ".DS_Store",
  ".venv",
  "__pycache__",
  "node_modules",
]);

function shouldCopyOfficialPluginAsset(sourcePath) {
  const name = basename(sourcePath);
  return !excludedOfficialPluginAssetNames.has(name) && !name.endsWith(".pyc");
}
const isBootstrapWithRemote = process.env.ZCODE_BOOTSTRAP_WITH_REMOTE === "1";

function buildCliBundle() {
  console.log("[prepare:agent-bundle] building zcode-cli app-server bundle ...");
  // 复用仓库根脚本（turbo build:desktop-agent --filter=@zcode/cli），命中缓存时几乎瞬时。
  runCommand(process.execPath, [resolve(repoRoot, "scripts/build-desktop-agent-cli.mjs")], {
    cwd: repoRoot,
    env: pnpmRunEnv,
  });
  if (!existsSync(cliBundlePath)) {
    throw new Error(
      `[prepare:agent-bundle] expected cli bundle missing after build: ${cliBundlePath}`,
    );
  }
}

export async function buildOfficialPluginRuntimes({
  root = repoRoot,
  plugins = officialPluginPackages,
  bootstrap = isBootstrapWithRemote,
  run = runCommand,
} = {}) {
  for (const plugin of plugins) {
    if (!plugin.requiresRuntime) continue;
    console.log(`[prepare:agent-bundle] building ${plugin.packageName} runtime ...`);
    if (plugin.runtimeBuildScript === BUILTIN_OFFICE_PLUGIN_BUILD_SCRIPT) {
      // Office 无本地 tsconfig，且旧 dist 不代表当前源码；两种 prepare 都只跑真实共享 build。
      await run(process.execPath, [plugin.runtimeBuildScript], {
        cwd: resolve(root, plugin.relativePath),
        env: pnpmRunEnv,
      });
    } else if (bootstrap) {
      buildOfficialPluginRuntimeForBootstrap(plugin, root, run);
    } else {
      await run(
        "pnpm",
        ["--dir", resolve(root, "apps/zcode-cli"), "--filter", plugin.packageName, "build"],
        { cwd: root, env: pnpmRunEnv },
      );
    }
    await assertOfficialPluginRuntime(plugin, root);
  }
}

function buildOfficialPluginRuntimeForBootstrap(plugin, root, run) {
  const pluginRoot = resolve(root, plugin.relativePath);
  const hasCompleteRuntime = plugin.requiredRuntimePaths.every((relativePath) =>
    existsSync(resolve(pluginRoot, ...relativePath.split("/"))),
  );
  if (plugin.packageName !== BROWSER_USE_PLUGIN_PACKAGE_NAME && hasCompleteRuntime) {
    console.log(
      `[prepare:agent-bundle] reuse existing official plugin runtime: ${plugin.packageName}`,
    );
    return;
  }

  // bootstrap:with-remote 会连续构建 remote assets 和桌面 agent bundle。
  // 通过 pnpm/filter 进入插件 build 时，tsc shim 在本地低内存环境中容易被 SIGKILL；
  // 这里仅在 bootstrap 开关下用当前 Node 直接执行等价 tsc + build-mcp，不改变插件自身 build 脚本。
  // browser-use 的 server 与 browser-client 是同一发布对；即使旧 server.js 存在也必须重建，
  // 否则会把旧 server 与当前 client（或缺失 client）一起 stage 到桌面安装包。
  run(process.execPath, ["../../node_modules/typescript/bin/tsc"], {
    cwd: pluginRoot,
    env: process.env,
  });
  run(process.execPath, [plugin.runtimeBuildScript], {
    cwd: pluginRoot,
    env: process.env,
  });
}

async function assertOfficialPluginRuntime(plugin, root = repoRoot) {
  const pluginRoot = resolve(root, plugin.relativePath);
  for (const relativePath of plugin.requiredRuntimePaths) {
    const runtimePath = resolve(pluginRoot, ...relativePath.split("/"));
    const entry = await stat(runtimePath).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!entry?.isFile()) {
      throw new Error(`[prepare:agent-bundle] missing official plugin runtime: ${runtimePath}`);
    }
  }
}

function stageBundle() {
  // 实现已抽到 stage-agent-bundle.mjs：dev 链（scripts/build-desktop-agent-cli.mjs）
  // 必须用同一份，否则 dev 会继续跑上一次打包留下的陈旧 agent。
  stageAgentBundle({ repoRoot, platformKey });
}

export async function stageOfficialPlugins(
  targetGlmDir = glmDir,
  { root = repoRoot, plugins = officialPluginPackages } = {},
) {
  for (const plugin of plugins) {
    const sourceRoot = resolve(root, plugin.relativePath);
    await access(resolve(sourceRoot, ".zcodium-plugin", "plugin.json"));
    // 缺件必须在复制前失败，不能由目标旧文件掩盖损坏的 Office 源产物。
    await assertOfficialPluginRuntime(plugin, root);
    const targetRoot = resolve(targetGlmDir, plugin.stagedPath);
    await mkdir(targetRoot, { recursive: true });
    for (const entryName of includedOfficialPluginTopLevelPaths) {
      const sourcePath = resolve(sourceRoot, entryName);
      if (!existsSync(sourcePath)) continue;
      const targetPath = resolve(targetRoot, entryName);
      if (
        entryName === "dist" &&
        plugin.runtimeBuildScript === BUILTIN_OFFICE_PLUGIN_BUILD_SCRIPT
      ) {
        // 完整 dist 是一个发布单元；先清旧树再递归复制，移除过期 worker/font/许可残留。
        await rm(targetPath, { recursive: true, force: true });
      }
      await cp(sourcePath, targetPath, {
        recursive: true,
        filter: shouldCopyOfficialPluginAsset,
      });
    }
    if (plugin.directory === "node-repl-host") {
      await stageCuaDriverRuntime(targetRoot, { platform, arch });
    }
    for (const relativePath of plugin.requiredSeedPaths ?? []) {
      const stagedAssetPath = resolve(targetRoot, ...relativePath.split("/"));
      const entry = await stat(stagedAssetPath).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!entry?.isFile()) {
        throw new Error(
          `[prepare:agent-bundle] missing staged official plugin seed asset: ${stagedAssetPath}`,
        );
      }
    }
    console.log(`[prepare:agent-bundle] staged official plugin ${plugin.stagedPath}`);
  }
  if (plugins === officialPluginPackages) {
    await validateBuiltinPluginAssets(resolve(targetGlmDir, "packages"), { platform, arch });
  }
}

async function stageBundledSkillPack() {
  const sourceRoot = resolve(repoRoot, bundledSkillPack.relativePath);
  const targetRoot = resolve(glmDir, bundledSkillPack.stagedPath);
  await mkdir(targetRoot, { recursive: true });
  for (const entryName of bundledSkillPack.topLevelPaths) {
    const sourcePath = resolve(sourceRoot, entryName);
    await cp(sourcePath, resolve(targetRoot, entryName), {
      recursive: true,
      filter: shouldCopyOfficialPluginAsset,
    });
  }
  for (const relativePath of bundledSkillPack.requiredPaths) {
    const stagedAssetPath = resolve(targetRoot, ...relativePath.split("/"));
    await access(stagedAssetPath);
  }
  console.log(`[prepare:agent-bundle] staged bundled skill pack ${bundledSkillPack.stagedPath}`);
}

// Electron 生产包只带 resources/glm/zcode.cjs 时，app-server 进程的
// __dirname 附近没有官方插件目录，启动时 seed 找不到 source，用户侧不会自动得到内置插件。
// 这里把官方插件按 bootstrap 的 rootCandidates 期望放到 glm/packages/*-plugin，
// 让 Electron Node 运行 zcode.cjs 时复用同一套 filesystem seed 逻辑。
// browser-use runtime 的声明生成依赖 @zcode/core/dist。CI 干净检出没有该产物，
// 必须先构建 CLI 依赖，再构建官方插件；开发机残留的 dist 曾掩盖这个顺序问题。
const entryHref = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (entryHref === import.meta.url) {
  buildCliBundle();
  await buildOfficialPluginRuntimes();
  stageBundle();
  await stageOfficialPlugins();
  await stageBundledSkillPack();
}
