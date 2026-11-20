import type { ExtensionHostNetworkSettings } from "#src/extension-host/contract.js";

/**
 * 5 分钟内最多自动重启 3 次，退避 1s、2s、4s；第 4 次崩溃时停止。
 * 修复：最初按「崩溃 3 次即停」实现，第 3 次就停，4s 退避永远用不上，与退避表矛盾。
 * 上限从退避表长度推出，两者只有一个来源。
 */
const CRASH_WINDOW_MS = 5 * 60_000;

const RESTART_BACKOFF_MS = [1_000, 2_000, 4_000] as const;

const MAX_AUTO_RESTARTS = RESTART_BACKOFF_MS.length;

/** 每 5 秒探测一次；连续 3 次没有回应判为卡死。所有构建行为相同。 */
const PROBE_INTERVAL_MS = 5_000;

const PROBE_MAX_MISSES = 3;

const DISPOSE_FORCE_KILL_MS = 1_500;

/**
 * 环境变量白名单：扩展进程运行第三方代码，不继承 Window Host 的环境
 * （里面有遥测凭据与 OAuth 配置，desktopRuntimeEnv.ts）。白名单只在这里定义。
 */
export const EXTENSION_HOST_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SystemRoot",
  "windir",
  "APPDATA",
  "LOCALAPPDATA",
  "NODE_ENV",
] as const;

const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] as const;

const NO_PROXY_ENV_KEYS = ["NO_PROXY", "no_proxy"] as const;

const CA_ENV_KEYS = ["NODE_EXTRA_CA_CERTS"] as const;

/** 代理地址的翻译与 CLI 相同（agentProxyEnv.ts、CLI 的 subprocess-env.ts）：裸 host:port 补 http://。 */
function normalizeProxy(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

/** No Proxy 规范成逗号分隔、去掉空项，与 CLI 相同。 */
function normalizeNoProxy(value: string | undefined): string | undefined {
  const tokens = value
    ?.split(",")
    .map((token) => token.trim())
    .filter(Boolean);
  return tokens && tokens.length > 0 ? tokens.join(",") : undefined;
}

/**
 * 写设置页的值，大小写两种形式都写：Node 的环境代理小写优先（http_proxy 先于 HTTP_PROXY）。
 * Windows 的变量名不分大小写，只写一份。
 */
function setEnv(
  env: Record<string, string>,
  keys: readonly string[],
  value: string,
  platform: NodeJS.Platform,
): void {
  const seen = new Set<string>();
  for (const key of keys) {
    const identity = platform === "win32" ? key.toUpperCase() : key;
    if (seen.has(identity)) continue;
    seen.add(identity);
    env[key] = value;
  }
}

/**
 * 白名单 ⊕ 设置页的网络出口（§12.1、§18.1 H3）。代理、No Proxy 与自定义 CA 只来自设置页，
 * 与 CLI 相同：设置页留空就直连，不读 shell 环境里的同名变量。
 * 修复原因（用户决策，2026-11-05）：最初设置页留空时沿用 Main 环境的代理变量，CLI 这时却是直连，
 * 两个进程的出口规则不一致，设置页「不读取系统环境变量」的说明对扩展不成立。所以这些变量不进白名单。
 */
export function buildExtensionHostEnv(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  network: ExtensionHostNetworkSettings = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  const seen = new Set<string>();
  for (const key of EXTENSION_HOST_ENV_ALLOWLIST) {
    // Windows 的环境变量名不区分大小写：HTTP_PROXY 与 http_proxy 是同一个变量，只传一次。
    const identity = platform === "win32" ? key.toUpperCase() : key;
    if (seen.has(identity)) continue;
    const value = source[key];
    if (value === undefined) continue;
    seen.add(identity);
    env[key] = value;
  }
  const proxy = normalizeProxy(network.httpProxy);
  if (proxy) setEnv(env, PROXY_ENV_KEYS, proxy, platform);
  const noProxy = normalizeNoProxy(network.noProxy);
  if (noProxy) setEnv(env, NO_PROXY_ENV_KEYS, noProxy, platform);
  const caCertPath = network.caCertPath?.trim();
  if (caCertPath) setEnv(env, CA_ENV_KEYS, caCertPath, platform);
  env.ZCODE_PROCESS_LABEL = "extension-host";
  return env;
}

/** 日志只记每项是否由设置页配置，不记地址与路径：代理地址可能带账号密码。 */
function describeNetworkSources(network: ExtensionHostNetworkSettings): string {
  const source = (configured: string | undefined) => (configured?.trim() ? "settings" : "none");
  return `proxy=${source(network.httpProxy)} noProxy=${source(network.noProxy)} ca=${source(network.caCertPath)}`;
}

interface WindowHostEntry {
  ready: boolean;
}

type ExitIntent = "planned" | "dispose" | "unresponsive";
export {
  CRASH_WINDOW_MS,
  RESTART_BACKOFF_MS,
  MAX_AUTO_RESTARTS,
  PROBE_INTERVAL_MS,
  PROBE_MAX_MISSES,
  DISPOSE_FORCE_KILL_MS,
  PROXY_ENV_KEYS,
  NO_PROXY_ENV_KEYS,
  CA_ENV_KEYS,
  normalizeProxy,
  normalizeNoProxy,
  setEnv,
  describeNetworkSources,
  type WindowHostEntry,
  type ExitIntent,
};
