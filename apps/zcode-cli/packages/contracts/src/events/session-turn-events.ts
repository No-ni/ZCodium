import type { RuntimeInputPresentation } from "../interfaces/runtime-input-presentation.js";
import type {
  MessageVisibility,
  SyntheticUserMessageSource,
} from "../interfaces/session-store.port.js";
import type {
  TurnSteerDeliveryMode,
  TurnSteerRejectReason,
  TurnSteerSource,
} from "../protocol-values/contract.js";
import type {
  TurnInputIntentMetadata,
  TurnSteerCommandKind,
} from "../interfaces/session-input-intent.js";
import type { MessageId, QueryId, TurnId } from "../interfaces/shared.js";
import type { ModelUsageSummary } from "../protocol-values/model-contract.js";
import type {
  WorkflowLaunchMeta,
  TurnExecutionKind,
  BackgroundResultOriginMeta,
  TurnAttachmentMeta,
  TurnBackgroundAttribution,
} from "./session-lifecycle-events.js";
import type { Attachment, ErrorPayload } from "./session-event-values.js";

export interface TurnStartedPayloadBase {
  /** 当前输入/后台因果链的客户端来源，仅用于统计。 */
  inputOrigin?: "desktop" | "mobile";
  /** 执行入口的单调 epoch 毫秒；hooks/持久化发生在 TurnStarted 发布前，不能据发布时间反推执行开始。 */
  executionStartedAt?: number;
  turnNumber: number;
  input: string;
  /**
   * v4 文件摘要按 turn rowId 发起 query，但 workspace checkpoint 以 user messageId
   * 为恢复锚点；TurnStarted 必须携带同一个持久 id，投影才能把 userInput row
   * 反查到对应 checkpoint。
   */
  messageId?: MessageId;
  inputId?: string;
  /** 由 admission 明确标记执行来源，不能从 session 归属反推。 */
  /** 同一 runtime command 内覆盖 primary turn → goal verify/continue 的稳定取消身份。 */
  foregroundExecutionId?: string;
  queryId?: QueryId;
  inputSource?: SyntheticUserMessageSource;
  inputVisibility?: MessageVisibility;
  /**
   * 中枢直接启动已保存工作流的启动轮元数据（`inputSource === "workflow_launch"` 时在场）。
   * 活投影据它画启动卡；与消息 metadata 里的同一份对齐（冷热同形）。
   */
  workflowLaunch?: WorkflowLaunchMeta;
  /** 缺省为 agent，兼容旧事件与历史 transcript。 */
  executionKind?: TurnExecutionKind;
  /**
   * `input` 从此下标起是引擎附加文本（dwf ask 尾注 / nudge），GUI 把它折进披露；0 = 整条都是；
   * 缺席 = 无。与消息 metadata 里的同一份对齐（冷热同形）。
   */
  epilogueStart?: number;
  /** idle background wake 的结构化来源；active-loop 合流不会创建独立 TurnStarted。 */
  originMeta?: BackgroundResultOriginMeta;
  /** 仅当一个 background notification batch 的所有成员来源一致时透传；混合来源留空。 */
  backgroundSource?: BackgroundResultOriginMeta["backgroundSource"];
  targetId?: string;
  /** 本轮用户输入的附件元信息（无附件时缺省）。 */
  attachments?: TurnAttachmentMeta[];
  /** CLI admission metadata；inputId 继续作为 sourceCommandId 兼容锚点。 */
  intent?: TurnInputIntentMetadata;
}

export type TurnStartedPayload = TurnStartedPayloadBase & TurnBackgroundAttribution;

export interface TurnInputReceivedPayload {
  input: string;
  attachments?: Attachment[];
}

export interface TurnSteerQueuedPayload {
  pendingInputId: string;
  inputId?: string;
  queryId?: QueryId;
  input: string;
  inputPreview: string;
  inputSize: number;
  commandKind?: TurnSteerCommandKind;
  source?: TurnSteerSource;
  inputPresentation?: RuntimeInputPresentation;
  /** Host 准入注入的可信 automation 身份；禁止从追踪字段恢复。 */
  automationId?: string;
  /** 当前排队输入消费时不向 provider 暴露的工具名。 */
  toolDisallowlist?: readonly string[];
  /** 投递语义：queue=消费时切新 product turn；guide=内联当前轮。 */
  delivery?: TurnSteerDeliveryMode;
  targetTurnId: TurnId;
  queueLength: number;
  intent?: TurnInputIntentMetadata;
}

export interface TurnSteerDeliveryChangedPayload {
  pendingInputId: string;
  targetTurnId: TurnId;
  requestedDelivery: "guide";
  admittedDelivery: "queue";
  fallbackReasonCode: string;
  /** 已改投后的完整 intent；reducer/cold replay 不从旁路状态猜 delivery。 */
  intent?: TurnInputIntentMetadata;
}

export interface TurnSteerReorderedPayload {
  orderedPendingInputIds: string[];
  targetTurnId: TurnId;
}

export interface TurnSteerDispatchChangedPayload {
  pendingInputId: string;
  reservationId?: string;
  state: "queued" | "reserved" | "promoting";
  targetTurnId: TurnId;
}

/** editorId = 单个窗口/标签页的编辑器实例；clientId 同设备多窗口共享，不能单独作为归属。 */
export interface PendingInputEditLock {
  editorId: string;
  clientId: string;
  inputOrigin?: "desktop" | "mobile";
}

export interface TurnSteerEditLockChangedPayload {
  pendingInputId: string;
  targetTurnId: TurnId;
  /** 缺省 = 已释放。 */
  editLock?: PendingInputEditLock;
}

export interface QueueAutoDrainChangedPayload {
  autoDrain: boolean;
}

export interface FollowupModeChangedPayload {
  mode: "queue" | "guide";
}

export interface TurnSteerDrainedPayload {
  pendingInputIds: string[];
  queryIds?: QueryId[];
  targetTurnId: TurnId;
  injectedMessageIds: MessageId[];
  /**
   * drain 事实自带文本与持久 messageId，投影不再依赖
   * 内存 queue 状态取文本（查不到 queue item 就静默丢 user 行）。
   * delivery 决定切轮语义；缺省按 queue（每条一轮）。
   */
  drainedInputs?: Array<{
    pendingInputId: string;
    messageId: MessageId;
    text: string;
    delivery?: TurnSteerDeliveryMode;
    intent?: TurnInputIntentMetadata;
    toolDisallowlist?: readonly string[];
  }>;
}

export interface TurnSteerRejectedPayload {
  reason: TurnSteerRejectReason;
  activeTurnId?: TurnId;
  expectedTurnId?: TurnId;
  inputPreview?: string;
  inputSize?: number;
}

export interface TurnSteerDiscardedPayload {
  pendingInputIds: string[];
  targetTurnId: TurnId;
  // user_removed（v4 queue 单项删除）：用户显式从 queue 移除某项，区别于 turn 生命周期丢弃。
  // promoted：sendQueuedNow 已取得执行权，只从 queue 投影摘除；session_input 必须继续
  // 保持 admitted，直到 user message 原子 promotion（或重启后 discarded）。
  reason: "turn_cancelled" | "turn_failed" | "session_resumed" | "user_removed" | "promoted";
}

export interface SessionInputPromotedPayload {
  pendingInputId: string;
  sourceCommandId: string;
  messageId: MessageId;
}

export interface TurnCompletePayload {
  response: string;
  tokenCount: number;
  usage?: ModelUsageSummary;
  toolCallCount: number;
  /** 当前 query 已成功提交到 provider 可见持久历史的模型产物数量。 */
  historyRoundCount?: number;
  duration: number;
  inputId?: string;
  resultType: TurnResultType;
  /** 当前 turn 是否消费过来源为 subagent 的后台结果通知。 */
  backgroundSubagentResultConsumed?: boolean;
  /** 当前 turn 是否消费过来源为 workflow（dynamic-workflow run）的后台通知。 */
  workflowResultConsumed?: boolean;
  /** 内部抢占（如 sendQueuedNow）只终止当前 turn，不等价于用户手动 Stop 队列。 */
  preserveQueueAutoDrainOnCancel?: boolean;
}

export interface TurnErrorPayload {
  error: ErrorPayload;
  turnPhase: string;
  inputId?: string;
  /** 当前 turn 是否消费过来源为 subagent 的后台结果通知。 */
  backgroundSubagentResultConsumed?: boolean;
  /** 当前 turn 是否消费过来源为 workflow（dynamic-workflow run）的后台通知。 */
  workflowResultConsumed?: boolean;
}

export type TurnResultType =
  | "success"
  // "cancelled": 用户主动中断（TurnCancelled）属于正常结束，复用 TurnComplete 上报而非 TurnError。
  | "cancelled"
  | "error_max_turns"
  | "error_max_budget"
  | "error_during_execution"
  | "error_max_tool_calls";
