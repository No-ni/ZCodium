import { type McpAppsResourcePermission } from "./resourcePermissions.js";
import { MCP_APPS_RESOURCE_MIME_TYPE, type McpAppCspRelaxations } from "./clientCapabilities.js";
export {
  PLUGIN_SANDBOX_PORT_NAME,
  type PluginSandboxTransportPort,
  type PluginSandboxPortsEvent,
  type PluginSandboxPlatformPort,
  type PluginSandboxCaptureRequest,
} from "./sandboxPorts.js";

export {
  MCP_APPS_EXTENSION_ID,
  MCP_APPS_RESOURCE_MIME_TYPE,
  type McpAppsClientCapability,
  buildMcpAppsClientCapabilities,
  MCP_APPS_CSP_RELAXATION_META_KEY,
  MCP_APPS_CSP_RELAXATION_FLAGS,
  type McpAppCspRelaxationFlag,
  type McpAppCspRelaxations,
  buildMcpAppsCspExperimentalCapability,
} from "./clientCapabilities.js";

export {
  MCP_APPS_RESOURCE_PERMISSIONS,
  type McpAppsResourcePermission,
  MCP_APPS_IFRAME_ALLOW_TOKENS,
  buildMcpAppsIframeAllow,
} from "./resourcePermissions.js";

export {
  MCP_APPS_HOST_NAME,
  MCP_APPS_HOST_VERSION,
  MCP_APPS_HANDSHAKE_TIMEOUT_MS,
  MCP_APPS_TEARDOWN_TIMEOUT_MS,
} from "./hostIdentity.js";

/** 弃用的扁平键 `_meta["ui/resourceUri"]`；规范要求宿主 MUST 同时兼容，与官方 SDK `RESOURCE_URI_META_KEY` 一致。 */
export const MCP_APPS_LEGACY_RESOURCE_URI_META_KEY = "ui/resourceUri";

export type McpAppsDisplayMode = "inline" | "fullscreen" | "pip";

export type McpAppsToolVisibility = "model" | "app";

export const MCP_APPS_DEFAULT_TOOL_VISIBILITY: readonly McpAppsToolVisibility[] = ["model", "app"];

/** MCP Apps 资源级 CSP（`McpUiResourceCsp`）：四类域。资源 `_meta` 为主，工具级 `_meta.ui.csp` 只在资源没有声明时兜底。 */
export interface McpToolUiCsp {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
}

/**
 * `ui://` HTML 资源自己的 `_meta`（`resources/read` 内容项优先）。`heightHint` / `minFrameHeight` 是初始高度与
 * 最小高度（px）；`showInline` 为 true 时卡片强制常驻、不进折叠区。
 */
export interface McpAppResourceMeta {
  csp?: McpToolUiCsp;
  cspRelaxations?: McpAppCspRelaxations;
  /** `_meta.ui.permissions` 声明的浏览器权限（规范四键；顺序固定、去重）。 */
  permissions?: McpAppsResourcePermission[];
  prefersBorder?: boolean;
  heightHint?: number;
  minFrameHeight?: number;
  showInline?: boolean;
  /** 资源级显式后台保留申请；缺省不保留，实际回收由宿主裁决。 */
  backgroundRetention?: boolean;
}

/** 随沙箱句柄回到 renderer 的资源级呈现信息；CSP 与放宽只在 main 生效，不回传。 */
export type PluginSandboxResourceMeta = Omit<McpAppResourceMeta, "csp" | "cspRelaxations">;

/** 工具 `_meta` 归一化后的 UI 描述；`resourceUri` 非法时整个描述不存在。 */
export interface McpToolUiDescriptor {
  resourceUri: string;
  visibility?: McpAppsToolVisibility[];
  preferredDisplayMode?: McpAppsDisplayMode;
  csp?: McpToolUiCsp;
  prefersBorder?: boolean;
  /** 工具结果归属的面板 id（清单 `ui.surfaces[].id`）。 */
  surface?: string;
  /** 工具级 `openai/widgetShowCodexWidgetInline`，卡片强制常驻。 */
  showInline?: boolean;
}

/** `_meta.ui.surface` / 清单 surface id 的长度与字符集（与 sandboxId 同源：可进 CSP host-source）。 */
export const MCP_APPS_SURFACE_ID_MAX_CHARS = 128;

export const MCP_APPS_SURFACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export const MCP_APPS_UI_RESOURCE_SCHEME = "ui://";

export const MCP_APPS_RESOURCE_URI_MAX_CHARS = 2048;

/**
 * `display.ui.structuredContent` / `widgetMeta` / `content` 的持久化上限（JSON 文本的 UTF-8 字节）。
 * 超限不截断字符串（半截 JSON 没有意义）：字段整个省略，`truncated: true` 且 `truncatedBytes` 记被丢弃的字节数；
 * 页面侧 `toolOutput` 为 null、`toolResponseMetadata["zcode/truncated"] = { bytes }`，可用 tools/call 重取。
 */
export const MCP_APPS_STRUCTURED_CONTENT_MAX_BYTES = 64 * 1024;

export const MCP_APPS_WIDGET_META_MAX_BYTES = 16 * 1024;

export const MCP_APPS_CONTENT_MAX_BYTES = 32 * 1024;

export const MCP_APPS_TRUNCATED_META_KEY = "zcode/truncated";

/** host 侧接受的 `ui://` HTML 上限与 mimeType 白名单（规范只认带 profile 的；无 profile 的 text/html 是有意的宽松超集）。 */
// 官方 pdf-server 示例的单文件页面（内联 pdf.js）就有 4.3 MB，4 MiB 会把它拒掉；放到 16 MiB。
export const MCP_APPS_HTML_MAX_BYTES = 16 * 1024 * 1024;

export const MCP_APPS_HTML_MIME_TYPES = [MCP_APPS_RESOURCE_MIME_TYPE, "text/html"] as const;

/**
 * 页面经 ui/update-model-context 与 ui/message 送来的 image 块：白名单三种位图，单张解码后 ≤ 4 MiB；
 * 不在白名单或超限整个请求 -32602 `unsupported_content`。
 */
export const MCP_APPS_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

export const MCP_APPS_IMAGE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * 页面发起的 `resources/read`（`mcp/uiReadResource`）单次结果总大小上限，以及 mimeType 白名单。
 * 白名单项以 `/` 结尾表示前缀匹配（如 `text/`），否则精确匹配（忽略参数与大小写）。
 */
export {
  MCP_APPS_UI_READ_RESOURCE_MAX_BYTES,
  MCP_APPS_UI_READ_RESOURCE_MIME_ALLOWLIST,
  isMcpAppsUiReadResourceMimeAllowed,
} from "./resourceMime.js";

/**
 * `hostCapabilities.experimental` 里 ZCode 扩展的键。官方 SDK 的 zod 会剥掉标准位之外的未知能力键，
 * 扩展一律放 experimental（规范预留位），页面按键 feature detect。
 */
export const MCP_APPS_WIDGET_STATE_EXPERIMENTAL_KEY = "zcode/widgetState";

export const MCP_APPS_RESOURCE_SUBSCRIBE_EXPERIMENTAL_KEY = "zcode/resourceSubscribe";

export const MCP_APPS_SURFACE_EXPERIMENTAL_KEY = "zcode/surface";

/**
 * 宿主允许插件文档内部创建子 frame（srcdoc / about:blank 预览、声明的 frameDomains）而不把它当作页面重载撤销实例。
 * 旧宿主会在子 frame 导航时停止页面；需要嵌套预览的插件据此键降级，而不是创建 frame 后被释放。
 */
export const MCP_APPS_NESTED_FRAMES_EXPERIMENTAL_KEY = "zcode/nestedFrames";

/**
 * ZCode 扩展方法 `ui/set-widget-state { widgetState }`（MCP Apps 无 widgetState）：页面把界面状态交给宿主
 * renderer 内存保存（不持久化，会话内重挂载可恢复）；初值经 hostContext 的 `zcode/widgetState` 键随握手下发。
 */
export const MCP_APPS_SET_WIDGET_STATE_METHOD = "ui/set-widget-state";

export const MCP_APPS_WIDGET_STATE_CONTEXT_KEY = "zcode/widgetState";

/**
 * 沙箱作用域。工具卡片按 toolCallId，面板（清单 `ui.surfaces[]`）按 surfaceId；
 * 两者都映射到一个字符串 scopeId 进注册表幂等键与 widgetState 路由，避免 main / host 认识"面板"概念。
 */
export type PluginUiScopeRef =
  | { kind: "toolCall"; toolCallId: string }
  | { kind: "surface"; surfaceId: string };

export function buildPluginSandboxScopeId(scope: PluginUiScopeRef): string {
  return scope.kind === "toolCall" ? `tool:${scope.toolCallId}` : `surface:${scope.surfaceId}`;
}

interface PluginSandboxRegisterRequestBase {
  instance: import("./instance.js").McpAppInstance;
  requestId: string;
  /** 工作区隔离；旧调用允许缺省，新宿主登记须贯穿实际 workspace 范围。 */
  workspacePath?: string;
  workspaceIdentity?: string;
  ownerWebContentsId: number;
  /** `buildPluginSandboxScopeId` 的结果：`tool:<toolCallId>` 或 `surface:<surfaceId>`；扩展视图为 `extension-view:<实例 id>`。 */
  scopeId: string;
  html: string;
  /** 有效 CSP：资源级优先，工具级兜底（host plugin-ui-bridge 已合并）。 */
  csp?: McpToolUiCsp;
  /** 资源级 `_meta["zcode/csp"]` 声明的放宽项。 */
  cspRelaxations?: McpAppCspRelaxations;
  /** 资源声明的浏览器权限；main 据此放宽 Permissions-Policy 与 iframe allow，并把权限请求交给闸门。 */
  permissions?: McpAppsResourcePermission[];
  prefersBorder?: boolean;
  /** 资源级尺寸提示，原样进句柄回给 renderer。 */
  heightHint?: number;
  minFrameHeight?: number;
  /** 资源级强制常驻标记，随句柄 resourceMeta 回 renderer。 */
  showInline?: boolean;
  backgroundRetention?: boolean;
}

/**
 * host → main 登记沙箱内容的消息载荷（模式同 LocalMediaPreviewPathAuthorize*）。
 * 只有扩展视图（docs/plugins/extension-host.md §8）不属于会话：它不填 sessionId，也不伪造会话 id；
 * MCP App 与 Gen UI 仍必须带会话。运行时校验见 validation.ts 的登记 schema 与 Main 注册表。
 */
export type PluginSandboxRegisterRequestPayload = PluginSandboxRegisterRequestBase &
  (
    | {
        contentKind?: undefined;
        sessionId: string;
        pluginId: string;
        /** 资源所属的 MCP server 运行时名；沙箱 partition 按它派生（同一 server 的页面共享一份持久存储）。 */
        serverName: string;
      }
    | {
        /** Gen UI has Host provenance and never impersonates an MCP plugin. */
        contentKind: "gen-ui";
        sessionId: string;
        pluginId?: undefined;
        serverName?: undefined;
      }
    | {
        /** 扩展视图：Window Host 签发凭证，appIdentity 按插件派生；没有会话与 MCP server 名。 */
        contentKind: "extension";
        sessionId?: undefined;
        pluginId: string;
        serverName?: undefined;
      }
  );

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** host 内部使用的登记输入：去掉传输层 requestId。 */
export type PluginSandboxRegisterInput = DistributiveOmit<
  PluginSandboxRegisterRequestPayload,
  "requestId"
>;

export interface PluginSandboxHandle {
  instance: import("./instance.js").McpAppInstance;
  sandboxId: string;
  initId: number;
  shellUrl: string;
  partition: string;
  /** 资源级呈现信息（prefersBorder / heightHint / minFrameHeight / showInline）；资源没声明时省略。 */
  resourceMeta?: PluginSandboxResourceMeta;
}

export type PluginSandboxRegisterResultPayload =
  | ({ requestId: string; ok: true } & PluginSandboxHandle)
  | { requestId: string; ok: false; error: string };
