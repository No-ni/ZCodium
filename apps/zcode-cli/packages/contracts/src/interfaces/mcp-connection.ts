import type { TraceContext } from "../tracing/tracer.js";
import type { McpServerStatus, McpServerConfig } from "./mcp-server-config.js";
import type { McpToolDescriptor, McpToolCallResult } from "./mcp-tool-contract.js";
import type {
  McpReadResourceRequest,
  McpReadResourceResult,
  McpListResourcesRequest,
  McpListResourcesResult,
  McpListResourceTemplatesResult,
  McpResourceSubscriptionRequest,
} from "./mcp-resources.js";

export interface McpConnectionSnapshot {
  statuses: Record<string, McpServerStatus>;
  tools: McpToolDescriptor[];
}

export interface McpConnectOptions {
  /**
   * authorization_code OAuth callback 的等待上限。
   * 普通 MCP timeoutMs 只约束协议请求，session 启动需要单独限制 OAuth 授权等待。
   */
  oauthAuthorizationTimeoutMs?: number;
  /**
   * 复用既有连接前先校验其存活性（见 McpPort.pingServer），已死则重连。
   * 设置页刷新这类"用户明确要求重新探测"的调用必须置位；session 启动不需要，
   * 复用池中刚建立的连接即可。
   */
  revalidate?: boolean;
  signal?: AbortSignal;
  trace?: TraceContext;
  workingDirectory?: string;
  /** 身份隔离使用 workspaceIdentity；本地缺省时才 fallback 到 workingDirectory。 */
  workspaceIdentity?: string;
  /**
   * 会话所属 workspace 的 key，只用于发往 Host 的请求（官方 MCP 授权头）。受管 worktree 会话 =
   * 项目；连接池分组仍按 workspaceIdentity || workingDirectory（stdio 进程的工作目录就是 cwd）。
   */
  workspaceKey?: string;
}

export interface McpCallToolRequest {
  serverName: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  trace?: TraceContext;
  /** 调用来源；宿主 MCP 可据此限制不能安全继承到 subagent 的能力。 */
  runtimeScope?: "main" | "subagent";
  /** 请求上下文仅用于 shared-host 隔离，不改变 MCP tool 参数。 */
  workspacePath?: string;
  workspaceIdentity?: string;
  workspaceKey?: string;
  remoteSessionId?: string;
  clientMode?: string;
  deliveryKind?: string;
  turnId?: string;
}

/** MCP `notifications/progress`（A8）：progress 单调递增，total 可缺省；adapter 原样转发，不做节流。 */
export interface McpToolCallProgress {
  progress: number;
  total?: number;
  message?: string;
}

export interface McpCallToolOptions {
  /** 页面写操作固定此连接；禁止恢复或重新授权后自动重放。 */
  appConnection?: { identity: string; generation: number };
  signal?: AbortSignal;
  timeoutMs?: number;
  /** 收到服务端进度通知时回调；SDK 侧同时以 resetTimeoutOnProgress 让每次进度重置超时。 */
  onProgress?: (progress: McpToolCallProgress) => void;
}

/** 工具级 `_meta.timeoutMs` 的允许区间：低于下限视为非法丢弃，高于上限截到上限。 */
export const MCP_TOOL_META_TIMEOUT_MIN_MS = 1_000;

export const MCP_TOOL_META_TIMEOUT_MAX_MS = 30 * 60 * 1_000;

/** MCP elicitation（server → client `elicitation/create`）交给宿主提问的端口。 */
export interface McpElicitationTrace {
  sessionId?: string;
  turnId?: string;
  toolCallId?: string;
  traceId?: string;
}

export interface McpElicitationRequest {
  serverName: string;
  message: string;
  requestedSchema: unknown;
  /** 发起 elicitation 时该 server 正在执行的工具调用；没有则无法归属会话，端口应拒绝。 */
  trace?: McpElicitationTrace;
}

export interface McpElicitationResult {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}

export interface McpElicitationPort {
  requestElicitation(
    request: McpElicitationRequest,
    options?: { signal?: AbortSignal },
  ): Promise<McpElicitationResult>;
}

export interface McpPort {
  /** 只读重算工作区准入并通知会话投影，不连接、授权或重放工具。 */
  refreshWorkspaceTrustAdmission?(reannounce?: boolean): Promise<void>;
  /** 可信配置派生的稳定来源与现有连接代际。断线时不签发新页面凭证。 */
  onAppConnectionInvalidated?(serverName: string, listener: () => void): () => void;
  appConnectionSnapshot?(serverName: string): { identity: string; generation: number } | null;
  /** 等待目标 server 已有连接任务；不重连、不等待其它 server，owner 失效后返回 null。 */
  waitForAppConnection?(
    serverName: string,
  ): Promise<{ identity: string; generation: number } | null>;

  connectConfiguredServers(
    servers: Record<string, McpServerConfig>,
    options?: McpConnectOptions,
  ): Promise<McpConnectionSnapshot>;
  connectServer(
    name: string,
    config: McpServerConfig,
    options?: McpConnectOptions,
  ): Promise<McpServerStatus>;
  disconnectServer(name: string): Promise<McpServerStatus | undefined>;
  /**
   * 主动探测连接是否仍然存活，返回 false 表示 transport 已断。
   * HTTP/SSE MCP 被停掉时不会派发 onclose，status() 会长期停在 connected；
   * 只有显式 ping 才能把这种"无声死亡"暴露出来。实现可选：未实现时调用方按存活处理。
   */
  pingServer?(name: string, options?: { timeoutMs?: number }): Promise<boolean>;
  status(): Promise<Record<string, McpServerStatus>>;
  listTools(): Promise<McpToolDescriptor[]>;
  /**
   * 自端口创建以来收到 `notifications/tools/list_changed` 的累计次数。
   * runtime 在回合开始前比较该值，变了才重新 listTools 并重注册；未实现表示端口不会主动变化。
   */
  toolListRevision?(): number;
  callTool(request: McpCallToolRequest, options?: McpCallToolOptions): Promise<McpToolCallResult>;
  /**
   * 读取 MCP 资源（插件 UI 的 `ui://` HTML）。与 pingServer 同样可选：mock port 不必实现，
   * 调用方缺失时按"不支持资源"处理。实现必须与 callTool 共用同一连接与重连路径。
   */
  readResource?(
    request: McpReadResourceRequest,
    options?: McpCallToolOptions,
  ): Promise<McpReadResourceResult>;
  /** 资源列表与订阅；缺省表示该端口不支持（协议层回 -32001）。 */
  listResources?(
    request: McpListResourcesRequest,
    options?: McpCallToolOptions,
  ): Promise<McpListResourcesResult>;
  listResourceTemplates?(
    request: McpListResourcesRequest,
    options?: McpCallToolOptions,
  ): Promise<McpListResourceTemplatesResult>;
  subscribeResource?(
    request: McpResourceSubscriptionRequest,
    options?: McpCallToolOptions,
  ): Promise<void>;
  unsubscribeResource?(
    request: McpResourceSubscriptionRequest,
    options?: McpCallToolOptions,
  ): Promise<void>;
  /** 删除 subscriberKey 以 prefix 开头的全部登记（会话关闭）；返回真正向 server 退订的 uri 数。 */
  unsubscribeResourcesBySubscriber?(subscriberKeyPrefix: string): Promise<number>;
  /**
   * 关闭本端口的准入和所属资源。pool lease 只取消本会话等待/调用并归还引用；
   * 独占连接等待 adapter 释放，共享连接仍由 pool 与其余 lease 持有。
   * child 借用端口不得关闭父会话持有的 lease。
   * 永久停止本 owner 的连接 admission 时，重复调用等待同一次所属资源回收，不影响其他活跃 owner。
   */
  close(): Promise<void>;
}
