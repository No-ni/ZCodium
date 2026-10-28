import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
  ZCODE_PLUGIN_HOST_COMMAND,
  type McpServerConfig,
} from "@zcode/contracts";
import { ZCODE_PLUGIN_ID_ENV_KEY } from "@zcode/shared";
import {
  createOfficialPluginCacheRetryBudget,
  type OfficialPluginCacheRetryBudget,
  writeTextFileAtomicallyWithRetry,
} from "./official-plugin-cache-fs.js";

type SeaModule = typeof import("node:sea");

const MCP_SERVER_RELATIVE_PATH = ["dist", "mcp", "server.js"] as const;

export function createBundledMcpRuntimeConfig(input: {
  cwd: string;
  env?: Record<string, string>;
  relativeServerPath?: readonly string[];
  rootPath: string;
  timeoutMs?: number;
}): McpServerConfig | undefined {
  const hostPrefixArgs = officialPluginHostPrefixArgs();
  if (!hostPrefixArgs) return undefined;
  return {
    args: [
      ...hostPrefixArgs,
      join(input.rootPath, ...(input.relativeServerPath ?? MCP_SERVER_RELATIVE_PATH)),
    ],
    command: process.execPath,
    cwd: input.cwd,
    env: {
      ...input.env,
      // 桌面打包态 process.execPath 是 ZCode Helper；缺少 Node 模式会误进 Electron main。
      ELECTRON_RUN_AS_NODE: "1",
    },
    timeoutMs: input.timeoutMs,
    type: "stdio",
  };
}

interface OfficialRuntimeManifestInput {
  sourceManifestContents?: string;
  pluginName: string;
  retryBudget?: OfficialPluginCacheRetryBudget;
  rootPath: string;
}

export function writeOfficialPluginRuntimeManifest(input: OfficialRuntimeManifestInput): void {
  const manifestPath = join(input.rootPath, ".zcodium-plugin", "plugin.json");
  const currentContents = readFileSync(manifestPath, "utf8");
  // 缓存入口可能已被旧版本改坏；两条 seed 路径都传原 manifest，不能用缓存推测 Office 入口。
  const manifest = JSON.parse(input.sourceManifestContents ?? currentContents) as Record<
    string,
    unknown
  >;
  // skill-only / command-only 类型的 official plugin 不带 mcpServers，直接跳过 rewrite。
  // 之前这里无脑 asRecord(manifest.mcpServers) 会对 undefined 抛错，
  // 把 seed 流程整个阻断，连带 listZCodeSkills 拉不出 plugin skill。
  if (manifest.mcpServers === undefined) return;
  const mcpServers = asRecord(manifest.mcpServers);
  const hostPrefixArgs = officialPluginHostPrefixArgs();
  if (!hostPrefixArgs) return;

  // 保留对其他历史 official plugin MCP 的通用重写；zcode-cua 当前是 skill/SDK-only，
  // 不会进入这个分支，也不会生成独立的 CUA MCP server。
  for (const [serverKey, serverRaw] of Object.entries(mcpServers)) {
    const mcpServer = asRecord(serverRaw);
    // HTTP/SSE 复用原 transport；无条件 stdio 重写会破坏远端配置且凭空生成入口。
    if (mcpServer.type === "http" || mcpServer.type === "sse" || typeof mcpServer.url === "string")
      continue;
    const mcpServerEnv = isRecord(mcpServer.env) ? mcpServer.env : {};
    const args = runtimeServerArgs(mcpServer.args, input.rootPath);
    mcpServer.command = process.execPath;
    mcpServer.type = "stdio";
    mcpServer.args = [...hostPrefixArgs, ...args];
    mcpServer.env = {
      ...mcpServerEnv,
      // 桌面打包态的 process.execPath 是 ZCode Helper。
      // 官方插件 MCP server 缺少 Node 模式 env 时会误进 Electron main，触发 deep-link 注册等桌面副作用。
      ELECTRON_RUN_AS_NODE: "1",
      // 权威写入插件身份（pluginName@marketplace，来自本地 plugin registry，manifest/user env 不可覆盖）。
      // 其他 official plugin 仍带上不可伪造的 plugin identity；CUA broker 凭据由 shared
      // node_repl 的可信配置注入，不再写入独立 server。
      [ZCODE_PLUGIN_ID_ENV_KEY]: `${input.pluginName}@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`,
    };
    mcpServers[serverKey] = mcpServer;
  }
  manifest.mcpServers = mcpServers;

  const nextContents = `${JSON.stringify(manifest, null, 2)}\n`;
  // 启动时无条件 rename 同内容的 plugin.json 会放大 Windows 杀毒/索引器
  // 的短暂文件占用。字节完全一致时不触碰文件；真正有更新时仍保持原子的失败语义。
  if (nextContents === currentContents) return;
  writeTextFileAtomicallyWithRetry(
    manifestPath,
    nextContents,
    input.retryBudget ?? createOfficialPluginCacheRetryBudget(),
  );
}

function runtimeServerArgs(value: unknown, rootPath: string): string[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.some((arg) => typeof arg !== "string" || arg.includes("\0"))
  )
    throw new Error("Official plugin manifest has invalid MCP server args.");
  const args = value as string[];
  // 不带 source 的历史调用也不能重复前缀；只剥离既有 plugin-host 后面的真实入口。
  const hostIndex = args.lastIndexOf(ZCODE_PLUGIN_HOST_COMMAND);
  const original = hostIndex < 0 ? args : args.slice(hostIndex + 1);
  if (!original.length) throw new Error("Official plugin manifest has invalid MCP server entry.");
  const expand = (arg: string) => arg.replace(/\$\{(?:CLAUDE|ZCODE)_PLUGIN_ROOT\}/g, rootPath);
  const root = resolve(rootPath);
  const entry = resolve(root, expand(original[0]));
  const rel = relative(root, entry);
  const allowed = new Set([join("dist", "server.mjs"), join(...MCP_SERVER_RELATIVE_PATH)]);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`) || !allowed.has(rel))
    throw new Error("Official plugin manifest has invalid MCP server entry.");
  // Office server.mjs 与历史 mcp/server.js 保留各自入口及其参数，不从目录名推断。
  return [entry, ...original.slice(1).map(expand)];
}

export function officialPluginHostPrefixArgs(): string[] | undefined {
  if (isSeaRuntime()) return [ZCODE_PLUGIN_HOST_COMMAND];

  const entrypoint = process.argv[1];
  if (!entrypoint) return undefined;

  return [...process.execArgv, resolve(entrypoint), ZCODE_PLUGIN_HOST_COMMAND];
}

function isSeaRuntime(): boolean {
  const getBuiltinModule = process.getBuiltinModule as ((id: "node:sea") => SeaModule) | undefined;
  try {
    return getBuiltinModule?.("node:sea").isSea() === true;
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error("Official plugin manifest has invalid mcpServers.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
