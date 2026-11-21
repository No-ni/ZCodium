import type { ModelProviderId, ModelId } from "../protocol-values/contract.js";
import type { ModelToolReferenceContentBlock } from "../protocol-values/contract.js";
import type { ModelCallWrapper } from "../tools/deferred-tool-call.js";

export type ModelMessageRole = "system" | "user" | "assistant" | "tool";

export interface ModelToolCall {
  id: string;
  name: string;
  input: unknown;
  providerExecuted?: boolean;
  /** Provider 原生调用元数据（如 Gemini thoughtSignature），随同一调用持久化与回放。 */
  providerOptions?: Record<string, unknown>;
  /** Canonical target/input 保持真实工具；请求副本按 marker 还原 Local wrapper。 */
  modelCallWrapper?: ModelCallWrapper;
  /** 本次模型响应内的块到达序号，与 text / reasoning 块共用序号空间；旧数据可缺失。 */
  blockIndex?: number;
}

export type AttachmentKind = "local_file" | "resource" | "inline";

export interface AttachmentRef {
  id: string;
  kind: AttachmentKind;
  uri?: string;
  path?: string;
  mimeType?: string;
  sizeBytes?: number;
  sha256?: string;
  placeholder?: string;
}

export interface ModelTextContentBlock {
  type: "text";
  text: string;
  /** assistant 块到达序号，只用于请求投影排序，不进入 provider 请求。 */
  blockIndex?: number;
}

export interface ModelReasoningContentBlock {
  type: "reasoning";
  text: string;
  providerOptions?: Record<string, unknown>;
  /** assistant 块到达序号，只用于请求投影排序，不进入 provider 请求。 */
  blockIndex?: number;
}

export interface ModelImageContentBlock {
  type: "image";
  mediaType: string;
  dataUrl: string;
  detail?: "auto" | "low" | "high" | "original";
  source?: AttachmentRef;
}

export interface ModelFileContentBlock {
  type: "file";
  mediaType: string;
  name?: string;
  uri?: string;
  dataUrl?: string;
  text?: string;
  source?: AttachmentRef;
}

/** 视频输入内容块（provider-neutral，与 image 同构；只承载 base64 dataUrl）。 */
export interface ModelVideoContentBlock {
  type: "video";
  mediaType: string;
  dataUrl: string;
  source?: AttachmentRef;
}

export interface ModelResourceLinkContentBlock {
  type: "resource_link";
  uri: string;
  name?: string;
  title?: string;
}

export type ModelMessageContentBlock =
  | ModelTextContentBlock
  | ModelReasoningContentBlock
  | ModelImageContentBlock
  | ModelVideoContentBlock
  | ModelFileContentBlock
  | ModelResourceLinkContentBlock
  | ModelToolReferenceContentBlock;

export type ModelMessageContent = string | ModelMessageContentBlock[];

export interface ModelCacheControl {
  type: "ephemeral";
  ttl?: "5m" | "1h";
  scope?: "global" | "org";
}

export interface ModelInputMessage {
  role: ModelMessageRole;
  content: ModelMessageContent;
  cacheControl?: ModelCacheControl;
  toolCalls?: ModelToolCall[];
  toolCallId?: string;
  toolName?: string;
  /** 工具结果保留调用时的 wrapper；恢复历史时不得按当前工具目录重写。 */
  modelCallWrapper?: ModelCallWrapper;
  isError?: boolean;
  providerId?: ModelProviderId;
  modelId?: ModelId;
  /**
   * 这条 assistant 由一次签名修复后成功的请求产出：它之前的已签名/redacted reasoning
   * 已被服务端判为失效，之后的请求投影一律不再发送（见 anthropic-reasoning-history-replay.md）。
   */
  signedReasoningReset?: boolean;
}

export function modelMessageContentToText(content: ModelMessageContent): string {
  if (typeof content === "string") return content;

  return content.map(modelMessageContentBlockToText).filter(Boolean).join("\n\n");
}

export function modelMessageContentBlockToText(block: ModelMessageContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "reasoning":
      return "";
    case "tool_reference":
      return block.toolName;
    case "image":
      return attachmentPlaceholder("Attached", block.mediaType, block.source?.placeholder);
    case "video":
      return attachmentPlaceholder("Attached", block.mediaType, block.source?.placeholder);
    case "file":
      if (block.text !== undefined && block.text.length > 0) return block.text;
      return attachmentPlaceholder(
        "Attached",
        block.mediaType,
        block.name ?? block.source?.placeholder,
      );
    case "resource_link":
      return `[Resource: ${block.title ?? block.name ?? block.uri}]`;
  }
}

function attachmentPlaceholder(prefix: string, mediaType: string, name?: string): string {
  return name && name.length > 0 ? `[${prefix} ${mediaType}: ${name}]` : `[${prefix} ${mediaType}]`;
}
