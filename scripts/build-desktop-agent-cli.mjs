import {
  BUILTIN_OFFICE_PLUGIN_BUILD_SCRIPT,
  BUILTIN_PLUGIN_ASSETS,
} from "@zcode/shared/builtin-plugin-assets";
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stageAgentBundle } from "../packages/desktop/scripts/stage-agent-bundle.mjs";
import { buildOfficialPluginRuntimes } from "../packages/desktop/scripts/prepare-agent-node-bundle.mjs";
import { runCommand } from "./spawn-command.mjs";
import { resolveBuiltinProviderBuildEnvironment } from "./builtin-provider-config.mjs";
import { stageDevCuaPluginRuntime } from "./stage-dev-cua-plugin-runtime.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const useTurboBuild = process.env.ZCODE_DESKTOP_AGENT_BUILD_MODE === "turbo";
const useBootstrapWithRemoteBuild = process.env.ZCODE_BOOTSTRAP_WITH_REMOTE === "1";
// 官方开源电脑操作：dev/prebuild 的 CUA 插件 runtime 必须与 Agent bundle 同源暂存。
// ZCODE_CUA_DEV_MODE 只作为 staging helper 的输入，不进入最终 product/runtime 环境；
// 开源占位 producer 不提供原生能力时，helper 自己返回空集，不会伪造出可用 Helper。
const cuaPluginRuntimeStagingEnv = {
  ...process.env,
  ZCODE_CUA_DEV_MODE: "1",
};
const officePluginAssets = BUILTIN_PLUGIN_ASSETS.filter(
  ({ runtimeBuildScript }) => runtimeBuildScript === BUILTIN_OFFICE_PLUGIN_BUILD_SCRIPT,
);
// 桌面 Agent 构建有普通 pnpm 和 bootstrap:with-remote 直跑 tsc 两条路径。
// 过去两条路径分别维护依赖顺序，新增 workspace 依赖时只更新了 bootstrap 依赖，
// 干净 CI 中该依赖的 dist 尚不存在，bootstrap 会因无法解析类型入口而失败。
// 两条路径统一从这一份有序清单派生，避免后续新增 workspace 依赖时再次漂移。
const cliWorkspaceBuilds = [
  { packageName: "@zcode/shared-types", packageDir: "shared-types" },
  { packageName: "@zcode/contracts", packageDir: "contracts" },
  // dynamic-workflow 的 tsc 构建依赖 gitignored 的 libs.generated.ts，
  // 而 bare-tsc 路径（runBootstrapWithRemoteBuild）不会执行 package build script，
  // 所以需要先跑生成脚本；必须排在 @zcode/core 之前，core 依赖 dynamic-workflow。
  {
    packageName: "@zcode/dynamic-workflow",
    packageDir: "dynamic-workflow",
    prepareScript: "scripts/generate-libs.mjs",
  },
  // dynamic-workflow-runtime 的类型入口是 dist/index.d.ts，必须先于 bootstrap 构建。
  { packageName: "@zcode/dynamic-workflow-runtime", packageDir: "dynamic-workflow-runtime" },
  { packageName: "@zcode/core", packageDir: "core" },
  { packageName: "@zcode/adapters", packageDir: "adapters" },
  { packageName: "@zcode/i18n", packageDir: "i18n" },
  { packageName: "@zcode/bootstrap", packageDir: "bootstrap" },
];
// 官方插件 manifest 可以在 server.js 缺失时被 filesystem seed，直到 session
// 连接 MCP 才报错，造成“Helper ready 但 CUA 工具不存在”的半启动状态。所有普通 Dev 必需的
// 独立 MCP runtime 必须集中登记，并在构建后验证真实入口文件，再允许 Agent bundle 启动。
export const requiredDevPluginRuntimeBuilds = [
  {
    packageName: "@zcode/android-emulator-plugin",
    artifactPath: "android-emulator-plugin/dist/mcp/server.js",
  },
  {
    packageName: "@zcode/ios-simulator-plugin",
    artifactPath: "ios-simulator-plugin/dist/mcp/server.js",
  },
  {
    // node_repl 宿主：Browser Use 与 Computer Use 共用，产物归属独立包。
    packageName: "@zcode/node-repl-host",
    artifactPath: "node-repl-host/dist/mcp/server.js",
  },
  {
    // browser-use 自己的 runtime 只剩 browser-client；宿主不再由它携带。
    packageName: "@zcode/browser-use-plugin",
    artifactPath: "browser-use-plugin/scripts/browser-client.mjs",
  },
  ...officePluginAssets.map((plugin) => ({
    packageName: plugin.packageName,
    artifactPaths: plugin.requiredRuntimePaths.map((path) => `${plugin.directory}/${path}`),
  })),
];
const defaultBuildFilters = [
  ...cliWorkspaceBuilds.map(({ packageName }) => packageName),
  ...requiredDevPluginRuntimeBuilds
    .filter(
      ({ packageName }) => !officePluginAssets.some((plugin) => plugin.packageName === packageName),
    )
    .map(({ packageName }) => packageName),
];

export async function buildOfficeDevPluginRuntimes({ root = repoRoot, run = runCommand } = {}) {
  // Dev沿用准备链唯一Office调度，不能再造tsc或按旧dist判断的平行实现。
  await buildOfficialPluginRuntimes({ root, plugins: officePluginAssets, run });
}

async function verifyRequiredDevPluginRuntimeArtifacts() {
  for (const runtime of requiredDevPluginRuntimeBuilds) {
    for (const path of runtime.artifactPaths ?? [runtime.artifactPath]) {
      const artifactPath = resolve(repoRoot, "apps/zcode-cli/packages", path);
      try {
        await access(artifactPath);
      } catch (error) {
        throw new Error(
          `[build-desktop-agent-cli] ${runtime.packageName} build succeeded without required MCP runtime: ${artifactPath}`,
          { cause: error },
        );
      }
    }
  }
}

/**
 * 把刚构建出的 agent bundle 暂存进 bundled-agents。
 *
 * 必须做：dev 未打包时 agent 二进制由 desktopRuntimeEnv.ts 的
 * resolveBundledZCodeAgentBinaryPath() 解析，候选**只有** bundled-agents/，没有
 * cli/dist/。只靠打包链暂存会让 dev 一直跑上一次打包留下的那份 —— 实测陈旧
 * 3 天，任何 agent CLI 侧改动在 dev 里静默不生效，把「改动没进去」伪装成「代码没作用」。
 * 实现与打包链共用 stage-agent-bundle.mjs，两边不可能再各自漂移。
 *
 * dev 只跑宿主平台，所以 platformKey 直接取 process；打包链的跨平台 target 由它自己解析。
 */
function stageDevAgentBundle() {
  stageAgentBundle({
    repoRoot,
    platformKey: `${process.platform}-${process.arch}`,
  });
}

async function runBootstrapWithRemoteBuild(pnpmRunEnv) {
  // 仅有旧 bundle 文件不能证明它来自本次源码；远端资源必须重建当前 Agent。
  for (const { packageDir, prepareScript } of cliWorkspaceBuilds) {
    // bootstrap:with-remote 会在 remote assets 阶段构建 agent bundle。
    // 通过 pnpm 逐包执行 tsc 时会再走 shim/env node 层，低内存本地环境里容易长时间卡住。
    // 这里只有 bootstrap 专用环境变量生效，直接复用当前 Node 启动 TypeScript CLI。
    // bare tsc 绕过 package build script，所以带 prepareScript 的包（dynamic-workflow）
    // 必须先手动跑生成脚本补齐 gitignored 的 libs.generated.ts，否则 tsc 因缺文件报错。
    if (prepareScript) {
      runCommand(process.execPath, [prepareScript], {
        cwd: `apps/zcode-cli/packages/${packageDir}`,
        env: pnpmRunEnv,
        stdio: "inherit",
      });
    }
    runCommand(process.execPath, ["../../node_modules/typescript/bin/tsc"], {
      cwd: `apps/zcode-cli/packages/${packageDir}`,
      env: pnpmRunEnv,
      stdio: "inherit",
    });
  }

  runCommand(process.execPath, ["scripts/build.mjs", "--desktop-agent"], {
    cwd: "apps/zcode-cli/packages/cli",
    env: pnpmRunEnv,
    stdio: "inherit",
  });
}

async function main() {
  // adapters构建内存预算只影响显式执行，不让导入测试修改宿主环境或触发产品构建。
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ? process.env.NODE_OPTIONS + " " : ""}--max-old-space-size=8192`;
  const pnpmRunEnv = {
    ...process.env,
    ZCODE_ENV: await resolveBuiltinProviderBuildEnvironment({ root: repoRoot }),
    PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
  };
  if (useBootstrapWithRemoteBuild) {
    await runBootstrapWithRemoteBuild(pnpmRunEnv);
    await buildOfficeDevPluginRuntimes();
    stageDevAgentBundle();
    stageDevCuaPluginRuntime({ env: cuaPluginRuntimeStagingEnv });
    return;
  }

  if (!useTurboBuild) {
    // 根workspace保证CLI对共享包的依赖可解析；两条路径复用同一有序构建清单。
    for (const filter of defaultBuildFilters) {
      runCommand("pnpm", ["--filter", filter, "build"], {
        env: pnpmRunEnv,
        stdio: "inherit",
      });
    }
    await buildOfficeDevPluginRuntimes();
    await verifyRequiredDevPluginRuntimeArtifacts();
    runCommand("pnpm", ["--filter", "@zcode/cli", "build:desktop-agent"], {
      env: pnpmRunEnv,
      stdio: "inherit",
    });
    stageDevAgentBundle();
    stageDevCuaPluginRuntime({ env: cuaPluginRuntimeStagingEnv });
    return;
  }

  runCommand(
    "pnpm",
    [
      "exec",
      "turbo",
      "--skip-infer",
      "--cwd",
      "apps/zcode-cli",
      "run",
      "build:desktop-agent",
      "--filter=@zcode/cli",
    ],
    { env: pnpmRunEnv, stdio: "inherit" },
  );
  await verifyRequiredDevPluginRuntimeArtifacts();
  stageDevAgentBundle();
  stageDevCuaPluginRuntime({ env: cuaPluginRuntimeStagingEnv });
}

const entryHref = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (entryHref === import.meta.url) {
  await main();
}
