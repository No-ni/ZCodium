import type { TraceContext } from "../tracing/tracer.js";

export interface McpReadResourceRequest {
  serverName: string;
  uri: string;
  trace?: TraceContext;
}

export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
  _meta?: Record<string, unknown>;
}

export interface McpReadResourceResult {
  contents: McpResourceContent[];
}

/** `resources/list` / `resources/templates/list`（分页游标原样透传）。 */
export interface McpListResourcesRequest {
  serverName: string;
  cursor?: string;
  trace?: TraceContext;
}

export interface McpResourceDescriptor {
  uri: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
  _meta?: Record<string, unknown>;
}

export interface McpListResourcesResult {
  resources: McpResourceDescriptor[];
  nextCursor?: string;
}

export interface McpResourceTemplateDescriptor {
  uriTemplate: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
  _meta?: Record<string, unknown>;
}

export interface McpListResourceTemplatesResult {
  resourceTemplates: McpResourceTemplateDescriptor[];
  nextCursor?: string;
}

/**
 * 资源订阅。`subscriberKey` 由调用方给出（bootstrap 用 sessionId|scopeId|generation），
 * 登记表在连接层按 (serverName, uri) 计数：0→1 才真调 SDK subscribe，1→0 才 unsubscribe；断连重连后按登记表重放。
 */
export interface McpResourceSubscriptionRequest {
  serverName: string;
  uri: string;
  subscriberKey: string;
  trace?: TraceContext;
}

/** server 没有声明 `capabilities.resources.subscribe` 时抛出（协议层映射为 -32001 not_supported）。 */
export class McpResourceSubscribeUnsupportedError extends Error {
  readonly code = "not_supported" as const;
  constructor(readonly serverName: string) {
    super(`MCP server ${serverName} does not support resource subscriptions`);
    this.name = "McpResourceSubscribeUnsupportedError";
  }
}

/** server → client 通知，adapter 转成宿主可消费的形状；订阅类通知带当前登记的 subscriberKey。 */
export type McpServerNotification =
  | { kind: "resourceUpdated"; serverName: string; uri: string; subscribers: string[] }
  | { kind: "resourceListChanged"; serverName: string; subscribers: string[] }
  | { kind: "toolListChanged"; serverName: string }
  | { kind: "loggingMessage"; serverName: string; level: string; logger?: string; data: unknown };

export interface McpNotificationPort {
  onNotification(notification: McpServerNotification): void;
}
