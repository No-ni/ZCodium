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
// - Electron 44 内置 Node 24.x，与 zcode-cli 的目标运行时一致；
// - 单平台体积从 ~180MB 降到 ~16MB，且同一份 JS 跨平台通用；
// - app-server 命令路径不会加载 @zcode/tui，所以这里天然不打包 TUI。
//
// 远端（SSH/WSL/Docker）没有 Electron，由 Source Server archive 自带目标 Node，互不影响。
// 本 fork 只发行 Windows/macOS 桌面包：此入口只准备本机 Agent 资产，不随桌面包构建 Linux 远端运行资源。

// 修复原因：清理旧插件 dist 时使用 rmSync，漏导入会在构建前抛出 ReferenceError。
import { existsSync, rmSync } from "node:fs";
// 修复原因：运行时/seed 核验与复制使用异步 fs API，漏导入会在干净 CI 的 prepare 阶段失败。
import { access, cp, mkdir, rm, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runCommand } from "../../../scripts/spawn-command.mjs";
import { validateBuiltinPluginAssets } from "../../../scripts/builtin-plugin-assets.mjs";
import { stageCuaDriverRuntime } from "../../../scripts/cua-driver-runtime-assets.mjs";
import { stageAgentBundle } from "./stage-agent-bundle.mjs";
import {
  isSharpRequiredByComputerUse,
  stageSharpIntoBundledAgents,
} from "./sharp-package-assets.mjs";
import { stageKoffiIntoBundledAgents } from "./koffi-package-assets.mjs";
import { BUNDLED_NPM_VERSION, stageBundledNpm } from "./bundled-npm-assets.mjs";

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
const NODE_REPL_HOST_PACKAGE_NAME = "@zcode/node-repl-host";
const CUA_PLUGIN_PACKAGE_NAME = "@zcode/zcode-cua-plugin";

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

function buildOfficialPluginRuntimeForBootstrap(plugin, root = repoRoot, run = runCommand) {
  const pluginRoot = resolve(root, plugin.relativePath);
  // 修复原因：通过 pnpm/filter 进入插件 build 时，tsc shim 在低内存环境里容易被 SIGKILL；
  // 这里用当前 Node 直接执行等价 tsc + build-mcp，不改变插件自身 build 脚本。
  // Bug 原因：过去除 browser-use 外只要 dist 文件齐全就复用，源码变化后 bootstrap 仍会
  // 打包上一代插件 runtime；所有代码型官方插件都必须在本轮重建。
  rmSync(resolve(pluginRoot, "dist"), { recursive: true, force: true });
  // 文档插件没有自己的 tsconfig（源码在 office-runtime），直接跑 tsc 会因找不到工程配置失败；
  // 只有带 tsconfig 的插件才需要这一步。
  if (existsSync(resolve(pluginRoot, "tsconfig.json"))) {
    run(process.execPath, ["../../node_modules/typescript/bin/tsc"], {
      cwd: pluginRoot,
      env: process.env,
    });
  }
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

// stdio MCP 的 npm/npx 回退（用户没装 Node 时由 Electron Node 运行随包 npm）。
// tarball 按 sha512 缓存在 node_modules/.cache，重复打包不再下载。
async function stageBundledNpmRuntime() {
  const stagedRoot = await stageBundledNpm({
    cacheDir: resolve(repoRoot, "node_modules", ".cache", "zcode-bundled-npm"),
    glmDir,
  });
  console.log(`[prepare:agent-bundle] staged npm@${BUNDLED_NPM_VERSION} into ${stagedRoot}`);
}

function stageSharpForNodeReplPlugin() {
  if (!isSharpRequiredByComputerUse({ desktopPackageRoot: desktopRoot })) {
    console.log(
      "[prepare:agent-bundle] Computer Use package does not declare sharp, skip sharp staging",
    );
    return;
  }
  // `sharp` 仍然外部化——它包含无法内联的 native .node，运行时从**所在包**的 node_modules
  // 解析。2026-09-11 起 node_repl 宿主的 bundle 归 @zcode/node-repl-host，所以 sharp 必须
  // stage 到宿主目录，否则宿主里的 `import sharp` 在打包后的 app 里解析不到。
  // CUA screenshot / get_app_state 的 native 依赖仍要放进 CUA plugin 自己的 node_modules；
  // Browser Use 目录保留一份兼容 staging。三份 staging 都位于 plugin 子目录下，避免
  // electron-builder 过滤 extraResources 根目录的 node_modules。
  const pluginStagedDirs = [
    [NODE_REPL_HOST_PACKAGE_NAME, resolve(glmDir, "packages", "node-repl-host")],
    [BROWSER_USE_PLUGIN_PACKAGE_NAME, resolve(glmDir, "packages", "browser-use-plugin")],
    [CUA_PLUGIN_PACKAGE_NAME, resolve(glmDir, "packages", "zcode-cua-plugin")],
  ];
  for (const [packageName, pluginStagedDir] of pluginStagedDirs) {
    if (!existsSync(resolve(pluginStagedDir, ".zcodium-plugin", "plugin.json"))) {
      console.log(`[prepare:agent-bundle] ${packageName} not staged, skip sharp staging`);
      continue;
    }
    stageSharpIntoBundledAgents({
      desktopPackageRoot: desktopRoot,
      glmDir: pluginStagedDir,
      targetPlatform: { os: platform, arch },
    });
    console.log(
      `[prepare:agent-bundle] staged sharp into ${resolve(pluginStagedDir, "node_modules")} (${platform}-${arch})`,
    );
  }
}

export function stageKoffiForCuaPlugin({
  root = repoRoot,
  targetGlmDir = glmDir,
  targetPlatform = { os: platform, arch },
} = {}) {
  const cuaPluginStagedDir = resolve(targetGlmDir, "packages", "zcode-cua-plugin");
  // 修复依据：本仓暂存的是 .zcodium-plugin；旧标记会跳过原生依赖，且来源必须沿 adapters 安装根解析。
  if (!existsSync(resolve(cuaPluginStagedDir, ".zcodium-plugin", "plugin.json"))) {
    console.log("[prepare:agent-bundle] zcode-cua-plugin not staged, skip koffi staging");
    return;
  }
  stageKoffiIntoBundledAgents({
    koffiPackageRoot: resolve(root, "apps/zcode-cli/packages/adapters"),
    glmDir: cuaPluginStagedDir,
    targetPlatform,
  });
  console.log(
    `[prepare:agent-bundle] staged koffi into ${resolve(cuaPluginStagedDir, "node_modules")} (${targetPlatform.os}-${targetPlatform.arch})`,
  );
}

// 修复原因：Electron 生产包只带 resources/glm/zcode.cjs 时，app-server 进程的
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
  // 吸收上游：MCP 的 Node/npm fallback 与 CUA / node-repl 的原生运行时必须随 Agent bundle 一起 stage，
  // 缺任一项都会在已安装应用里退化成「插件存在但跑不起来」。
  await stageBundledNpmRuntime();
  stageKoffiForCuaPlugin();
  stageSharpForNodeReplPlugin();
}
