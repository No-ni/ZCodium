import type { TurnSteerSource, TurnSteerDeliveryMode } from "../protocol-values/contract.js";
export type { TurnSteerSource, TurnSteerDeliveryMode } from "../protocol-values/contract.js";
import type {
  CollaborationMode,
  SessionStatus,
  RiskLevel,
  InputDelivery,
  TurnSteerRejectReason,
} from "../protocol-values/contract.js";
export type {
  CollaborationMode,
  SessionStatus,
  RiskLevel,
  InputDelivery,
  TurnSteerRejectReason,
} from "../protocol-values/contract.js";
export { inheritPermissionMode, restrictPermissionMode } from "../protocol-values/contract.js";
import type { RuntimeInputPresentation } from "./runtime-input-presentation.js";
import type { ErrorAttribution, SessionEvent } from "../events/session.events.js";
import type {
  InteractionRequestOrigin,
  MessageId,
  QueryId,
  SessionId,
  TurnId,
  TraceId,
} from "./shared.js";
import type { TraceContext } from "../tracing/tracer.js";
import type { CompactProjectionInfo } from "../compact/index.js";
import type { CheckpointProjectionInfo, RewindProjectionInfo } from "../rewind/index.js";
import type {
  StreamRecoveryAnchorProjectionInfo,
  StreamingToolLedgerProjectionInfo,
} from "../events/stream-recovery.events.js";
import type { SessionGoal } from "../tools/target.js";
import type { GoalCompletionVerificationOutput } from "../tools/target.js";
import type { PermissionOptionsPolicy, PermissionUpdate } from "./permission.port.js";
import type { ToolResultDisplayPayload } from "../tools/tool-result-metadata.js";
import type { ModelSelection } from "../model/model.js";
import {
  type TurnInputIntentMetadata,
  type PendingTurnAttachment,
  type TurnSteerCommandKind,
} from "./session-input-intent.js";
export {
  type TurnSteerCommandKind,
  type HighspeedMessageMetadata,
  type TurnInputSourceMetadata,
  PLUGIN_DISCOVERY_INPUT,
  type TurnInputIntentMetadata,
  type PendingTurnAttachment,
} from "./session-input-intent.js";

// -----------------------------------------------
// Session Event Store Port
// -----------------------------------------------

/** 内存 event store 的驻留规模；只用于本地内存诊断日志。 */
export interface SessionEventStoreStats {
  sessions: number;
  events: number;
  /** 按 turn 窗口策略已淘汰的瞬态事件累计数；unbounded 模式恒为 0。 */
  evictedEvents?: number;
  /** 当前仍驻留的瞬态事件数（进行中 turn + 一个滞后 turn）。 */
  retainedTransient?: number;
}

export interface SessionEventStorePort {
  append(event: SessionEvent): Promise<SessionEvent>;
  getEvents(sessionId: SessionId): Promise<SessionEvent[]>;
  getEventsAfter(sessionId: SessionId, sequenceNumber: number): Promise<SessionEvent[]>;
  getLatestSequenceNumber(sessionId: SessionId): Promise<number>;
  deleteSession(sessionId: SessionId): Promise<void>;
  /** 同步、O(sessions) 的只读统计；持久化实现可不提供。 */
  getStats?(): SessionEventStoreStats;
  /**
   * 低频 tick 触发的瞬态事件时间兜底淘汰；
   * 返回淘汰条数。持久化实现可不提供。
   */
  pruneTransientEvents?(nowMs?: number): number;
}

// -----------------------------------------------
// Live Session Event Sink Port
// -----------------------------------------------

export interface SessionEventSink {
  /** 可选目录是 live child 投影元数据，不写入原始事件账本。 */
  onSessionEvent(event: SessionEvent, executionWorkspacePath?: string): void | Promise<void>;
}

// -----------------------------------------------
// Session Projection Port
// -----------------------------------------------

export interface SessionProjection {
  id: SessionId;
  createdAt: Date;
  updatedAt: Date;
  mode: CollaborationMode;
  planEnabled?: boolean;
  status: SessionStatus;
  turnCount: number;
  totalTokenCount: number;
  contextUsed: number;
  contextWindow: number;
  pendingPermissions: PendingPermission[];
  pendingSteerInputs: PendingSteerInputInfo[];
  activeToolCalls: ActiveToolCall[];
  streamingToolLedger: StreamingToolLedgerProjectionInfo[];
  backgroundTasks: BackgroundTaskInfo[];
  currentTurnId?: TurnId;
  lastError?: ErrorInfo;
  lastCompact?: CompactProjectionInfo;
  lastCheckpoint?: CheckpointProjectionInfo;
  lastStreamRecoveryAnchor?: StreamRecoveryAnchorProjectionInfo;
  lastRewind?: RewindProjectionInfo;
  target?: SessionGoal | null;
  targetCompletionVerifications: GoalCompletionVerificationOutput[];
  targetCompletionVerificationTimeline: TargetCompletionVerificationProjectionInfo[];
}

export interface TargetCompletionVerificationProjectionInfo {
  targetId: string;
  status: "started" | "completed" | "failed_closed" | "cancelled";
  verificationId: string;
  verification?: GoalCompletionVerificationOutput;
  goalIteration?: number;
  anchorAssistantMessageId?: MessageId;
  anchorTurnId?: TurnId;
  startedAt?: Date;
  updatedAt: Date;
}

export interface PendingPermission {
  approvalMode?: "user-once";
  requestId?: string;
  toolCallId: string;
  toolName: string;
  reason?: string;
  riskLevel: RiskLevel;
  input?: unknown;
  suggestedPermissionUpdates?: PermissionUpdate[];
  origin?: InteractionRequestOrigin;
  /** 请求事件携带的 ask 预览；冷恢复重建的会话弹窗仍需带图，所以必须进 projection 状态。 */
  display?: ToolResultDisplayPayload;
  optionsPolicy?: PermissionOptionsPolicy;
  requestedAt: Date;
}

export interface PendingSteerInputInfo {
  pendingInputId: string;
  input: string;
  inputPreview: string;
  inputSize: number;
  commandKind?: TurnSteerCommandKind;
  source?: TurnSteerSource;
  inputPresentation?: RuntimeInputPresentation;
  /** Host 准入注入的可信 automation 身份；队列提升时必须原样恢复。 */
  automationId?: string;
  /** 当前排队输入附带的工具隐藏列表；automation busy 入队必须在消费时继续生效。 */
  toolDisallowlist?: readonly string[];
  queuedAt: Date;
  targetTurnId: TurnId;
  traceId: TraceId;
  intent?: TurnInputIntentMetadata;
}

export interface ActiveToolCall {
  toolCallId: string;
  toolName: string;
  status: ToolCallStatus;
  startedAt?: Date;
}

export type ToolCallStatus = "pending" | "running" | "completed" | "failed" | "denied";

export type BackgroundTaskInfoStatus =
  | "running"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "spawn_error"
  | "lost";

export interface BackgroundTaskInfo {
  taskId: string;
  toolCallId?: string;
  toolName?: string;
  taskKind?: "bash" | "subagent" | "workflow";
  childSessionId?: string;
  blocked?: boolean;
  blockedReason?: string;
  cancellable?: boolean;
  cancelRequestedAt?: Date;
  command?: string;
  description?: string;
  status: BackgroundTaskInfoStatus;
  pid?: number;
  startedAt?: Date;
  completedAt?: Date;
  outputPath?: string;
  stderrPersistedOutputPath?: string;
  stdoutPersistedOutputPath?: string;
  outputBytes?: number;
  outputTruncated?: boolean;
  outputTail?: string;
  stderrBytes?: number;
  stderrTail?: string;
  stdoutBytes?: number;
  stdoutTail?: string;
  terminalId?: string;
}

export interface BackgroundTaskCancelResult {
  cancelled: boolean;
  reason?: string;
  snapshot?: BackgroundTaskInfo;
  status: BackgroundTaskInfoStatus;
  taskId: string;
}

export interface ErrorInfo {
  attribution?: ErrorAttribution;
  code?: string;
  detail?: string;
  type: string;
  message: string;
}

// -----------------------------------------------
// Event Reducer Port
// -----------------------------------------------

export interface EventReducerPort {
  reduce(events: SessionEvent[]): SessionProjection;
  apply(projection: SessionProjection, event: SessionEvent): SessionProjection;
}

// -----------------------------------------------
// Session Manager Port
// -----------------------------------------------

export interface SessionManagerPort {
  createSession(config: SessionConfig): Promise<Session>;
  resumeSession(sessionId: SessionId): Promise<Session>;
  forkSession(sessionId: SessionId, forkPoint?: number): Promise<Session>;
  getSession(sessionId: SessionId): Promise<Session | null>;
  listSessions(): Promise<SessionSummary[]>;
}

export interface SessionConfig {
  mode?: CollaborationMode;
  contextWindow?: number;
  traceId?: TraceId;
}

export interface Session {
  id: SessionId;
  config: SessionConfig;
  eventStore: SessionEventStorePort;
  projection: SessionProjection;
  eventReducer: EventReducerPort;
}

export interface TurnSteerInput {
  /** 临时执行的选型不可成为普通 Session 续跑默认；不包含请求凭据。 */
  modelSelectionScope?: "execution";
  /** 仅加速卡输入携带普通模型快照，不含凭据；用于接纳时更新 Session。 */
  highspeedFallbackSelection?: ModelSelection;
  input: string;
  inputId?: string;
  queryId?: QueryId;
  expectedTurnId?: TurnId;
  commandKind?: TurnSteerCommandKind;
  source?: TurnSteerSource;
  inputPresentation?: RuntimeInputPresentation;
  delivery?: TurnSteerDeliveryMode;
  intent?: TurnInputIntentMetadata;
  attachments?: PendingTurnAttachment[];
  pendingInputId?: string;
  traceContext?: TraceContext;
  /** Host 准入注入的可信 automation 身份；不能从 inputId/queryId 推断。 */
  automationId?: string;
  /** 当前输入消费时不向 provider 暴露的工具名。 */
  toolDisallowlist?: readonly string[];
}

export interface PendingTurnInput {
  id: string;
  input: string;
  queuedAt: Date;
  traceId: TraceId;
  queryId?: QueryId;
  commandKind?: TurnSteerCommandKind;
  source?: TurnSteerSource;
  inputPresentation?: RuntimeInputPresentation;
  delivery?: TurnSteerDeliveryMode;
  intent?: TurnInputIntentMetadata;
  attachments?: PendingTurnAttachment[];
  /** Host 准入注入的可信 automation 身份；队列编辑和提升必须原样保留。 */
  automationId?: string;
  /** 当前 pending input drain 后不向 provider 暴露的工具名。 */
  toolDisallowlist?: readonly string[];
  turnId: TurnId;
}

export type TurnSteerResult =
  | {
      kind: "queued";
      pendingInputId: string;
      queueLength: number;
      turnId: TurnId;
    }
  | {
      activeTurnId?: TurnId;
      kind: "rejected";
      reason: TurnSteerRejectReason;
    };

export interface SessionSummary {
  id: SessionId;
  createdAt: Date;
  updatedAt: Date;
  mode: CollaborationMode;
  status: SessionStatus;
  turnCount: number;
}
