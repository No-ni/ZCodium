/** 兼容公开入口；声明按职责由内部叶文件唯一提供。 */
export type {
  McpServerTransportType,
  McpProtocolVersion,
  McpServerIsolation,
  McpServerRuntimeSource,
  McpServerConfigBase,
  McpClientCredentialsOAuthConfig,
  McpAuthorizationCodeOAuthConfig,
  McpOAuthConfig,
  McpStdioServerConfig,
  McpHttpServerConfig,
  McpSseServerConfig,
  McpServerConfig,
  McpServerStatusKind,
  McpServerStatus,
} from "./mcp-server-config.js";
export {
  ZCODE_MCP_ERROR_PRESENTATION_META_KEY,
  ZCODE_MCP_ERROR_PRESENTATION_MESSAGE_ONLY,
  ZCODE_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY,
  ZCODE_MCP_NODE_REPL_CUA_APP_META_KEY,
  ZCODE_MCP_SERVER_REQUEST_ID_META_KEY,
  resolveMcpToolVisibility,
} from "./mcp-tool-contract.js";
export type {
  McpToolAnnotations,
  McpToolDescriptor,
  McpContentBlock,
  McpToolCallResult,
} from "./mcp-tool-contract.js";
export { McpResourceSubscribeUnsupportedError } from "./mcp-resources.js";
export type {
  McpReadResourceRequest,
  McpResourceContent,
  McpReadResourceResult,
  McpListResourcesRequest,
  McpResourceDescriptor,
  McpListResourcesResult,
  McpResourceTemplateDescriptor,
  McpListResourceTemplatesResult,
  McpResourceSubscriptionRequest,
  McpServerNotification,
  McpNotificationPort,
} from "./mcp-resources.js";
export { MCP_TOOL_META_TIMEOUT_MIN_MS, MCP_TOOL_META_TIMEOUT_MAX_MS } from "./mcp-connection.js";
export type {
  McpConnectionSnapshot,
  McpConnectOptions,
  McpCallToolRequest,
  McpToolCallProgress,
  McpCallToolOptions,
  McpElicitationTrace,
  McpElicitationRequest,
  McpElicitationResult,
  McpElicitationPort,
  McpPort,
} from "./mcp-connection.js";
