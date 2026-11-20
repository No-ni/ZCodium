/**
 * MCP Apps 协议契约：agent、host、renderer 与 main 共用的常量、工具 UI 元数据类型、沙箱句柄与登记载荷。
 * 页面 ↔ 宿主的线协议（`ui/*` 方法、握手、版本协商、JSON-RPC）由官方 `@modelcontextprotocol/ext-apps` 定义，
 * 这里只保留 ZCode 自己的扩展键与限额。只放类型与常量；归一化与 schema 在同目录其他文件，经 index.ts 导出。
 */

/** MCP 扩展标识（规范「Extension Identifier」）；与官方 SDK `EXTENSION_ID` 一致。 */
export const MCP_APPS_EXTENSION_ID = "io.modelcontextprotocol/ui";

/** UI 资源 mimeType（规范 MUST）；与官方 SDK `RESOURCE_MIME_TYPE` 一致。 */
export const MCP_APPS_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";

/**
 * MCP client `initialize` 里的 ui 扩展能力声明（规范「Client (Host) Capabilities」）。
 * 用 type 而不是 interface：MCP SDK 的 `ClientCapabilities.extensions` 要求值带字符串索引签名。
 */
export type McpAppsClientCapability = { mimeTypes: string[] };

/** agent 对每个 MCP server 宣告的能力片段；放进 `Client` 构造参数的 `capabilities.extensions`。 */
export function buildMcpAppsClientCapabilities(): {
  extensions: { [extensionId: string]: McpAppsClientCapability };
} {
  return { extensions: { [MCP_APPS_EXTENSION_ID]: { mimeTypes: [MCP_APPS_RESOURCE_MIME_TYPE] } } };
}

/**
 * 资源级 `_meta["zcode/csp"]`：宿主缺省按规范块（只有 'self' 'unsafe-inline'），不放行 `'unsafe-eval'` /
 * `'wasm-unsafe-eval'`；需要 eval / WebAssembly 的资源在这里显式声明。宿主经
 * `hostCapabilities.experimental["zcode/csp"].flags` 宣告支持的键。
 */
export const MCP_APPS_CSP_RELAXATION_META_KEY = "zcode/csp";

export const MCP_APPS_CSP_RELAXATION_FLAGS = ["unsafeEval", "wasmUnsafeEval"] as const;

export type McpAppCspRelaxationFlag = (typeof MCP_APPS_CSP_RELAXATION_FLAGS)[number];

export type McpAppCspRelaxations = Partial<Record<McpAppCspRelaxationFlag, boolean>>;

export function buildMcpAppsCspExperimentalCapability(): {
  [MCP_APPS_CSP_RELAXATION_META_KEY]: { flags: McpAppCspRelaxationFlag[] };
} {
  return { [MCP_APPS_CSP_RELAXATION_META_KEY]: { flags: [...MCP_APPS_CSP_RELAXATION_FLAGS] } };
}
