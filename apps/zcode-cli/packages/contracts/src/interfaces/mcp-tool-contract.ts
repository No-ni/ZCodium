import type { McpAppsToolVisibility, McpToolUiDescriptor } from "@zcode/shared/mcp-apps";
import type { JsonSchema } from "../protocol-values/model-contract.js";

export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export const ZCODE_MCP_ERROR_PRESENTATION_META_KEY = "zcode/errorPresentation";

export const ZCODE_MCP_ERROR_PRESENTATION_MESSAGE_ONLY = "message-only";

/** MCP content 中来自模型显式 tab.screenshot() 的 image block 索引。 */
export const ZCODE_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY =
  "zcode/browserScreenshotContentIndices";

/**
 * 本次 node_repl cell 操作的目标应用身份，供工具卡显示 App 图标。
 *
 * **只能由 node-repl-host 写入**：宿主的 CUA bridge 从 broker 响应里读 producer 的
 * `zcode.cua/app-associations-v1`，投影成这里的最小形态。producer 那个键本身经
 * `nodeRepl.setResponseMeta` / `nodeRepl.emitStructuredResult` 也能到达 `_meta`，而这两个
 * API 挂在模型可见的 sandbox globals 上，因此不可信、必须在宿主侧丢弃（同
 * `ZCODE_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY` 的处置）。
 */
export const ZCODE_MCP_NODE_REPL_CUA_APP_META_KEY = "zcode/nodeReplCuaApp";

// 剥离上游新增的 browser_use / computer_use 会话能力统计键：本仓不采集 BUA/CUA 使用归因，
// node_repl 账本只用于执行归属（Planck 域），不再向 _meta 写这两个统计键。
/**
 * 远端 Server MCP 响应头里的 `x-request-id`，附在失败的 tool result 上（值为 string）。
 *
 * 用短前缀 `zcode/` 而不是 `com.zcode/`：这不是跨语言协议——服务端在 header 里给，客户端
 * 读到后自己搬进 `_meta`，产出与消费都在客户端（`com.zcode/` 留给 Go 侧直接产出的键，
 * 如 `com.zcode/mcp-unavailable`）。
 *
 * 只在 `isError` 时附加：这是给人看的排障线索（拿它去查服务端日志），成功路径上是纯噪声。
 */
export const ZCODE_MCP_SERVER_REQUEST_ID_META_KEY = "zcode/officialMcpServerRequestId";

export interface McpToolDescriptor {
  alwaysLoad?: boolean;
  searchHint?: string;
  serverName: string;
  toolName: string;
  name?: string;
  description?: string;
  timeoutMs?: number;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  annotations?: McpToolAnnotations;
  /**
   * 该 tool 的结果**可信到足以据此改变界面**：来自 `type: "http"` 且声明
   * `auth.type = zcode_official` 的 MCP server。
   *
   * 唯一用途是信任结果里的结构化标识（额度耗尽 / 无套餐的 `error_code`）。判据是"结果由谁产出"
   * 而不是"插件是谁"：
   * - http：响应来自 ZCode 后端。连接存活即意味着每个请求都过了 origin 校验且 fail closed，
   *   第三方插件即使声明官方鉴权，也只能把请求打到真实 ZCode，响应体不由它写；
   * - stdio：结果由插件进程自己产出、可任意伪造，因此**不置位**。
   *
   * 刻意**不**按"插件是否来自官方 marketplace"判定：那会让非官方安装源（含本地自测与
   * zcode-plugins-test）的官方插件失效，而它也不是真实屏障——详见 `@zcode/shared` 的
   * `isOfficialMcpOriginTrusted`。
   */
  official?: boolean;
  /**
   * 工具对谁开放（`_meta.ui.visibility`，缺省 `["model", "app"]`），与是否带 UI 资源无关。
   * 不含 "model" 的工具不进 provider contracts；不含 "app" 的工具拒绝 `mcp/uiCallTool`。
   * 由 adapter 归一化写入；缺省（旧 descriptor）时以 `ui.visibility` 兜底，再缺省视为两者都可见。
   */
  visibility?: McpAppsToolVisibility[];
  /**
   * 工具 `_meta` 归一化后的插件 UI 呈现描述。
   * 只有声明了合法 `ui://` resourceUri 的工具才有；其中的 visibility 与上面的字段同源。
   */
  ui?: McpToolUiDescriptor;
}

/** 可见性判定的唯一实现：descriptor.visibility → ui.visibility → 两者都可见。 */
export function resolveMcpToolVisibility(
  descriptor: Pick<McpToolDescriptor, "visibility" | "ui">,
): McpAppsToolVisibility[] {
  return descriptor.visibility ?? descriptor.ui?.visibility ?? ["model", "app"];
}

export type McpContentBlock = Record<string, unknown>;

export interface McpToolCallResult {
  content: McpContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}
