import type { ToolCallId } from "../interfaces/shared.js";
import type { ModelApiErrorPhase, ModelFailureExceptionKind } from "../model/observation.js";
import type { ToolResultDisplayPayload } from "../tools/tool-result-metadata.js";

// -----------------------------------------------
// Supporting Types
// -----------------------------------------------

export interface Attachment {
  type: "file" | "image" | "pdf" | "url";
  path?: string;
  content?: string;
  mimeType?: string;
}

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCallPayload[];
  toolCallId?: string;
}

export interface ToolCallPayload {
  id: ToolCallId;
  name: string;
  input: unknown;
}

export interface ToolResultPayload {
  success: boolean;
  content: string;
  display?: ToolResultDisplayPayload;
  perf?: import("../tools/performance.js").ToolExecutionPerformance;
  error?: ErrorPayload;
  truncated?: boolean;
  originalBytes?: number;
  returnedBytes?: number;
  budgetStrategy?: string;
  artifactPath?: string;
}

export interface ToolSchedulePayload {
  parallelGroups: ToolCallId[][];
  executionOrder: ToolCallId[];
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheTokens?: number;
}

export interface ErrorPayload {
  code?: string;
  detail?: string;
  /** 错误链中最深的非 wrapper frame 的原始 message，供客户端诊断 定位根因。 */
  underlyingErrorMessage?: string;
  /** 同一底层 frame 的 detail/errorDetails/details 内容。 */
  underlyingErrorDetail?: string;
  type: string;
  message: string;
  attribution?: ErrorAttribution;
  retryable?: boolean;
  stack?: string;
  data?: unknown;
}

/** 只承载可聚合的失败事实，不包含请求正文、凭据、URL 或监控策略。 */
export interface ErrorAttribution {
  source?: "provider" | "runtime" | "tool" | "network";
  reason?: string;
  errorPhase?: ModelApiErrorPhase;
  exceptionKind?: ModelFailureExceptionKind;
  providerId?: string;
  modelId?: string;
  providerKind?: string;
  transport?: "http" | "sse" | "websocket";
  statusCode?: number;
  providerErrorCode?: string;
  retryable?: boolean;
  /** string=使用该 Highspeed 卡，null=明确未使用，undefined=旧 Agent 未发布。 */
  highspeedCardId?: string | null;
  /**
   * true=本轮 Highspeed 创建期或请求期失败已命中退回声明，但所有退回目标都无法创建，整轮按真实错误
   * 结束。Renderer 据此作废匹配卡；不再按错误码推断，请求期 3402/网络失败的 code 是 provider 错误码。
   */
  highspeedFallbackUnavailable?: boolean;
}
