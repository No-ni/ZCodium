#!/usr/bin/env node

import process from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveNativeSearchReleasePlan } from "../../../scripts/native-search-tools-config.mjs";
import { runCommand } from "../../../scripts/spawn-command.mjs";
import { getTargetPlatform } from "./target-platform.mjs";
import { isComputerUseHelperProducerInstalled } from "./computer-use-producer.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const target = getTargetPlatform();
if (target.os !== "darwin" && target.os !== "win32") {
  throw new Error(`Unsupported desktop target OS: ${target.os}`);
}
const nativeSearchReleasePlan = resolveNativeSearchReleasePlan({
  platform: target.os,
  arch: target.arch,
});
// Windows Chrome 导入入口未启用，默认构建继续编译 helper 会增加 CI 时间和发布签名面。
// 保留显式开关，后续恢复入口时仍可复用既有原生实现和供应链校验。
const shouldPrepareWindowsBrowserImportHelper =
  target.os === "win32" && process.env.ZCODE_ENABLE_WINDOWS_BROWSER_IMPORT === "1";
// Windows Computer Use Helper 只由带 helper 产物契约的 producer 提供；本 fork 保留旧电脑操作后端
// （@trycua/cua-driver），它没有 zcodeCuaRuntime.windows 契约，官方 Helper 链必须整体保持 inert。
const shouldPrepareWindowsCuaHelper =
  target.os === "win32" &&
  isComputerUseHelperProducerInstalled({ desktopPackageRoot: desktopRoot });
// CUA 权限浮窗的吸附数据源。仅 macOS；缺 swiftc 时脚本内部自行降级为跳过（浮窗 fail-open
// 到屏幕底部，仍可用），所以无条件挂在 darwin 上不会让构建变脆。
const shouldPrepareMacosWindowBounds = target.os === "darwin";

// 本机桌面包只内置 agent 的 JS bundle（prepare:agent-bundle）与 Windows/macOS 原生 helper，
// 运行时由 app 的 Electron Node runtime 执行；官方 retire 的 glm 原生二进制入口（prepare:glm）不恢复，
// 远端 Source Server 资源也不由桌面包负责。native-search 归档随仓库分发，准备步骤只做本地解包校验。
const localRuntimeScripts = [
  "prepare:agent-bundle",
  ...(shouldPrepareWindowsCuaHelper ? ["prepare:windows-cua-helper"] : []),
  ...(nativeSearchReleasePlan.enabled ? ["prepare:native-search"] : []),
  ...(shouldPrepareWindowsBrowserImportHelper ? ["prepare:browser-import-helper"] : []),
  ...(shouldPrepareMacosWindowBounds ? ["prepare:macos-window-bounds"] : []),
];

function runTimedPnpmScript(scriptName) {
  const startMs = Date.now();
  console.log(`[ci][timer] prepare-runtime-assets:${scriptName} start`);
  try {
    runCommand(pnpmCommand, [scriptName], {
      cwd: desktopRoot,
      env: process.env,
    });
  } finally {
    console.log(
      `[ci][timer] prepare-runtime-assets:${scriptName} end duration_ms=${Date.now() - startMs}`,
    );
  }
}

for (const scriptName of localRuntimeScripts) {
  runTimedPnpmScript(scriptName);
}
