export type JsonSchema = Record<string, unknown>;

export type ModelProviderId = string & { readonly __brand: "ModelProviderId" };
export type ModelId = string & { readonly __brand: "ModelId" };

export const ModelRequestSessionType = {
  Main: "main",
  Other: "other",
  SideChat: "side_chat",
  Subagent: "subagent",
} as const;

/**
 * 模型请求的重试预算档位（runtime-only）。
 * - `default`：adapter 构造时解析出的 maxAttempts（默认 10 次重试）。
 * - `unbounded`：**瞬态**失败无上限重试（退避曲线不变、封顶 60s 后无限探测），永久失败照旧立即抛。
 *   给 workflow actor（taskType workflow_child / nested_workflow_child）使用：模型错误绝不是
 *   workflow 错误，唯一出口是用户 cancel。
 * - `single-attempt`：本次请求 maxAttempts 收敛为 1，瞬态失败也不重试、首次失败即上抛。
 *   给带 selectionFallback 声明的执行作用域 Selection（如 Highspeed 加速卡）使用：失败后由 core
 *   退回会话模型继续本轮，适配层再按默认 10 次退避重试只会把降级拖到数分钟之后。
 */
export const ModelRetryBudget = {
  Default: "default",
  Unbounded: "unbounded",
  SingleAttempt: "single-attempt",
} as const;

export type ModelRetryBudget = (typeof ModelRetryBudget)[keyof typeof ModelRetryBudget];

/**
 * 准入端口看到的模型身份：配额键的最小事实。既不是 Selection（那是执行意图），也不是
 * Active Model（那带完整配置）——treaty 只要 provider/model 两段。
 */
export interface ModelRequestTarget {
  providerId: string;
  modelId: string;
}

export type ModelRequestSessionType =
  (typeof ModelRequestSessionType)[keyof typeof ModelRequestSessionType];

export const ModelErrorCode = {
  InvalidModelSelection: "invalid_model_selection",
  ModelConfigMissing: "model_config_missing",
  ProviderNotFound: "provider_not_found",
  ProviderNotConfigured: "provider_not_configured",
  ModelNotFound: "model_not_found",
  InvalidModelRequest: "invalid_model_request",
  InvalidModelResponse: "invalid_model_response",
  ModelRequestFailed: "model_request_failed",
  ModelRequestAuthMissing: "model_request_auth_missing",
  ModelRequestCancelled: "model_request_cancelled",
  ModelRequestTimeout: "model_request_timeout",
  ModelRateLimited: "model_rate_limited",
  ModelContextExceeded: "model_context_exceeded",
} as const;

export type ModelErrorCode = (typeof ModelErrorCode)[keyof typeof ModelErrorCode];

export const ModelTransportKind = { Http: "http", Sse: "sse", WebSocket: "websocket" } as const;

export type ModelTransportKind = (typeof ModelTransportKind)[keyof typeof ModelTransportKind];

export const ModelRetryReason = {
  RateLimited: "rate_limited",
  ProviderOverloaded: "provider_overloaded",
  ServerError: "server_error",
  NetworkError: "network_error",
  Timeout: "timeout",
  StreamIdleTimeout: "stream_idle_timeout",
  StaleConnection: "stale_connection",
  AuthRefresh: "auth_refresh",
  /** Anthropic 明确拒绝历史 thinking signature 后，对请求副本清理并立即重试一次。 */
  ReasoningSignatureRepair: "reasoning_signature_repair",
} as const;

export type ModelRetryReason = (typeof ModelRetryReason)[keyof typeof ModelRetryReason];

export const ModelFailureReason = {
  ...ModelRetryReason,
  AuthFailed: "auth_failed",
  Cancelled: "cancelled",
  ContextExceeded: "context_exceeded",
  InvalidRequest: "invalid_request",
  ProviderNotConfigured: "provider_not_configured",
  ProxyError: "proxy_error",
  TlsError: "tls_error",
  Unknown: "unknown",
} as const;

export type ModelFailureReason = (typeof ModelFailureReason)[keyof typeof ModelFailureReason];

export class ModelProtocolError extends Error {
  readonly code: ModelErrorCode;
  readonly context?: Record<string, unknown>;

  constructor(code: ModelErrorCode, message: string, context?: Record<string, unknown>) {
    super(message);
    this.name = "ModelProtocolError";
    this.code = code;
    this.context = context;
  }
}

export function createModelProviderId(providerId: string): ModelProviderId {
  const normalized = providerId.trim();
  if (normalized.length === 0) {
    throw new ModelProtocolError(
      ModelErrorCode.InvalidModelSelection,
      "Model provider id is empty",
    );
  }
  return normalized as ModelProviderId;
}

export function createModelId(modelId: string): ModelId {
  const normalized = modelId.trim();
  if (normalized.length === 0) {
    throw new ModelProtocolError(ModelErrorCode.InvalidModelSelection, "Model id is empty");
  }
  return normalized as ModelId;
}

export type ModelToolSideEffectScope =
  | "none"
  | "workspace"
  | "git"
  | "network"
  | "system"
  | "session"
  | "userInteraction";

export type ModelToolChoice = "auto" | "none" | "required" | { type: "tool"; toolName: string };

export interface ModelRequestSettings {
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  stopSequences?: string[];
  seed?: number;
}

export interface ModelSource {
  type: "source";
  sourceType: "url" | "document";
  id?: string;
  url?: string;
  title?: string;
  mediaType?: string;
  filename?: string;
  providerMetadata?: Record<string, unknown>;
}

export interface ModelToolResult {
  id: string;
  name: string;
  input: unknown;
  output: unknown;
  providerExecuted?: boolean;
  providerMetadata?: Record<string, unknown>;
}
