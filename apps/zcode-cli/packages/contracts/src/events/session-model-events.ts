// ============================================================
// Session Events - All event types for the agent loop
// ============================================================
import type { HttpClientEgressInfo } from "../interfaces/http-client.port.js";
import type { CompactBoundaryPayload } from "../compact/index.js";
import type { SessionTitleSource } from "../interfaces/session-store.port.js";
import type { CollaborationMode } from "../protocol-values/contract.js";
import type { HighspeedMessageMetadata } from "../interfaces/session-input-intent.js";
import type { MessageId, PartId, ToolCallId, TurnId } from "../interfaces/shared.js";
import type { ModelUsage } from "../protocol-values/model-contract.js";
import type { ModelNetworkStatusEvent, ModelSelection } from "../model/index.js";
import type { GoalCompletionVerificationOutput, SessionGoal } from "../tools/target.js";
import type {
  Attachment,
  ToolCallPayload,
  ModelMessage,
  TokenUsage,
  ErrorPayload,
} from "./session-event-values.js";

export interface UserMessagePayload {
  content: string;
  attachments?: Attachment[];
}

export interface AssistantMessagePayload {
  content: string;
  toolCalls?: ToolCallPayload[];
}

export interface AssistantFeedbackUpdatedPayload {
  entityId: string;
  feedback: "like" | "dislike" | null;
}

export interface HighspeedMetricsUpdatedPayload {
  entityId: string;
  highspeed: HighspeedMessageMetadata;
}

export interface SystemMessagePayload {
  type: "init" | "compact_boundary" | "interrupted";
  content: string;
  compactBoundary?: CompactBoundaryPayload;
}

export interface SessionTitleUpdatedPayload {
  messageID?: MessageId;
  previousTitle: string;
  source: SessionTitleSource;
  title: string;
}

export interface SessionModeChangedPayload {
  permissionGrant?: { interactionId: string; queueItemIds: string[] };
  planEnabled?: boolean;
  previousPlanEnabled?: boolean;
  mode: CollaborationMode;
  previousMode: CollaborationMode;
  source: "tool" | "command" | "system";
  toolCallId?: ToolCallId;
}

export type TargetCompletionVerificationStatus =
  | "started"
  | "completed"
  | "failed_closed"
  | "cancelled";

export interface TargetCompletionVerificationPayload {
  targetId: string;
  status: TargetCompletionVerificationStatus;
  verificationId: string;
  /** 与触发该验证的前台 runtime command 共用，供 Stop 做 stale guard。 */
  foregroundExecutionId?: string;
  /** sendQueuedNow 抢占 verifier 时只暂停 goal，不暂停 future queue。 */
  preserveQueueAutoDrainOnCancel?: boolean;
  verification?: GoalCompletionVerificationOutput;
  goalIteration?: number;
  anchorAssistantMessageId?: MessageId;
  anchorTurnId?: TurnId;
}

export interface ModelRequestPayload {
  messages: ModelMessage[];
  providerId: string;
  modelId: string;
  querySource?: string;
  temperature?: number;
  maxTokens?: number;
}

export type ModelSelectionOrigin = "registryFallback";

export interface ModelSelectedPayload {
  modelSelection: ModelSelection;
  /** Active Model 已解析出的 reasoning，仅供执行事实/展示投影，不属于稀疏 Selection。 */
  effectiveReasoningLevel?: string;
  /** 缺失表示只更新当前选型；null 表示显式 ∅→selection 模型边界。 */
  previousModelSelection?: ModelSelection | null;
  /** 只有 Agent 自动恢复模型时携带；缺失表示普通选型或旧事件。 */
  origin?: ModelSelectionOrigin;
  /** 当前 selection 对应的思考档位能力；与模型选型同事件原子发布。 */
  supportedThoughtLevels?: string[];
  /** 当前 selection 在 runtime 实际应用的上下文窗口；null 表示显式清除，字段缺失兼容旧事件。 */
  contextWindow?: number | null;
}

/**
 * 执行 Selection 退回会话 Selection 的原因，与 @zcode/shared 的 selectionFallback 规则同值域：
 * 卡过期由声明的 provider 错误码命中，其余任何加速请求失败归为 request_failed。
 */
export type TurnExecutionModelFallbackReason =
  | "highspeed_card_expired"
  | "highspeed_request_failed"
  | "highspeed_selection_unavailable";

export interface TurnExecutionModelFallbackPayload {
  inputId?: string;
  reason: TurnExecutionModelFallbackReason;
  /**
   * Provider 重构后单轮执行模型统一用稀疏 Selection 表达（旧的 ModelRef 已删除）：
   * from 是本轮 execution 作用域的加速 Selection，to 是会话常驻 Selection。
   */
  fromModelSelection: ModelSelection;
  toModelSelection: ModelSelection;
}

export type ModelStreamingKind =
  | "start"
  | "text_start"
  | "text_delta"
  | "text_end"
  | "reasoning_start"
  | "reasoning_delta"
  | "reasoning_end"
  | "tool_input_start"
  | "tool_input_delta"
  | "tool_input_end"
  | "tool_call"
  | "finish"
  | "error";

export interface ModelStreamingPayload {
  delta: string;
  done: boolean;
  kind?: ModelStreamingKind;
  assistantMessageId?: MessageId;
  partId?: PartId;
  toolCallId?: ToolCallId;
  toolName?: string;
  input?: unknown;
  providerExecuted?: boolean;
}

export type ModelNetworkStatusPayload = ModelNetworkStatusEvent;

export type ModelAnomalyWarningCategory =
  | "tool_call_budget"
  | "repeated_tool_call"
  | "provider_finish_mismatch"
  | "malformed_tool_call";

export type ModelAnomalyWarningSeverity = "info" | "warning";

export interface ModelAnomalyWarningPayload {
  category: ModelAnomalyWarningCategory;
  severity: ModelAnomalyWarningSeverity;
  observedCount?: number;
  threshold?: number;
  toolName?: string;
  toolCallId?: ToolCallId;
  warningInjected: boolean;
  modelVisibleMessageId?: MessageId;
}

export type NetworkRequestSource = "http_client" | "model" | "tool" | "mcp" | "plugin" | "unknown";

export type NetworkRequestLifecycleStatus = "pending" | "complete" | "error";

export interface NetworkRequestStatusPayload {
  requestId: string;
  source: NetworkRequestSource;
  status: NetworkRequestLifecycleStatus;
  method: string;
  url: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  statusCode?: number;
  error?: string;
  toolCallId?: ToolCallId | string;
  toolName?: string;
  attempt?: number;
  egress?: HttpClientEgressInfo;
}

export interface ModelCompletePayload {
  cacheHit?: {
    inputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    latestHitRate: number | null;
    hitRate: number | null;
    hitRateRequestCount: number;
    totalInputTokens: number;
    totalCacheReadTokens: number;
    totalCacheWriteTokens: number;
  };
  content: string;
  contextUsageBreakdown?: ContextUsageBreakdownItem[];
  contextWindow?: number;
  fileChanges?: TurnFileChangeSummary;
  querySource?: string;
  stopReason: string;
  /** 当前模型请求组装出的完整 tool call 数量；旧事件可能缺失。 */
  toolCallCount?: number;
  usage: TokenUsage | ModelUsage;
}

export interface TurnFileChangeSummary {
  additions: number;
  deletions: number;
  files: number;
  items: TurnFileChangeSummaryItem[];
}

export interface TurnFileChangeSummaryItem {
  additions: number;
  deletions: number;
  path: string;
  toolNames?: string[];
  writeCount: number;
}

export type ContextUsageBreakdownSource =
  | "system_prompt"
  | "meta_user_context"
  | "skills"
  | "tool_prompt"
  | "system_tool_schemas"
  | "mcp_tool_schemas"
  | "messages";

export interface ContextUsageBreakdownItem {
  source: ContextUsageBreakdownSource;
  chars: number;
}

export interface ModelErrorPayload {
  error: ErrorPayload;
  retryable: boolean;
}

export type TargetChangedAction =
  | "set"
  | "status_updated"
  | "cleared"
  | "usage_accounted"
  | "run_started"
  | "run_finished"
  | "summary_updated";

export type TargetChangedSource = "command" | "tool" | "runtime";

export interface TargetChangedPayload {
  action: TargetChangedAction;
  source: TargetChangedSource;
  target: SessionGoal | null;
  previousTarget?: SessionGoal | null;
}
