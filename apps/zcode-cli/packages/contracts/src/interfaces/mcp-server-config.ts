// MCP Port - Model Context Protocol adapter boundary
// 官方 MCP 鉴权面（OfficialMcpAuth* / zcode_official）在本仓已删除，不随上游恢复；
// 这里只保留工作区信任审查与失败分类两个仍存在的 shared 契约。
import type { McpServerFailureKind, WorkspaceMcpTrustReview } from "@zcode/shared";

export type McpServerTransportType = "stdio" | "http" | "sse";

export type McpProtocolVersion = "legacy" | "auto" | "2026-07-28";

export type McpServerIsolation = "session" | "workspace";

/** 公共 MCP 配置校验完成后由宿主附加的运行时来源。 */
export interface McpServerRuntimeSource {
  kind: "builtin" | "plugin" | "workspace" | "user";
}

export interface McpServerConfigBase {
  alwaysLoad?: boolean;
  enabled?: boolean;
  isolation?: McpServerIsolation;
  protocolVersion?: McpProtocolVersion;
  /** 仅限宿主生成，公共配置 schema 会拒绝该字段。 */
  source?: McpServerRuntimeSource;
  timeoutMs?: number;
}

export interface McpClientCredentialsOAuthConfig {
  type: "client_credentials";
  clientId: string;
  clientSecret: string;
  clientName?: string;
  scope?: string;
}

export interface McpAuthorizationCodeOAuthConfig {
  type: "authorization_code";
  clientId?: string;
  clientSecret?: string;
  clientName?: string;
  redirectPath?: string;
  scope?: string;
}

export type McpOAuthConfig = McpAuthorizationCodeOAuthConfig | McpClientCredentialsOAuthConfig;

export interface McpStdioServerConfig extends McpServerConfigBase {
  type: "stdio";
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface McpHttpServerConfig extends McpServerConfigBase {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  oauth?: McpOAuthConfig;
}

export interface McpSseServerConfig extends McpServerConfigBase {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
  oauth?: McpOAuthConfig;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig | McpSseServerConfig;

export type McpServerStatusKind =
  | "connecting"
  | "connected"
  | "disabled"
  | "disconnected"
  | "failed"
  | "untrusted";

export interface McpServerStatus {
  workspaceTrust?: WorkspaceMcpTrustReview;
  status: McpServerStatusKind;
  transport: McpServerTransportType;
  toolCount: number;
  updatedAt: string;
  error?: string;
  failureKind?: McpServerFailureKind;
  serverRequestId?: string;
  protocolEra?: "legacy" | "modern";
  authorization?: { type: "oauth_authorization_code"; authorizationUrl: string; startedAt: string };
}
