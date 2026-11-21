import type { PermissionDecision } from "../protocol-values/contract.js";
import type { ExecutionOutputPreview } from "../interfaces/execution.port.js";
import type { PermissionOptionsPolicy, PermissionUpdate } from "../interfaces/permission.port.js";
import type { RiskLevel } from "../protocol-values/contract.js";
import type {
  InteractionRequestOrigin,
  MessageId,
  SessionId,
  ToolCallId,
} from "../interfaces/shared.js";
import type { SkillTelemetryMetadata } from "../skills/index.js";
import type { ToolSideEffectScope } from "../tools/contract.js";
import type { ToolResultDisplayPayload } from "../tools/tool-result-metadata.js";
import type {
  ToolSchedulePayload,
  ToolResultPayload,
  ErrorPayload,
} from "./session-event-values.js";

export interface ToolCallScheduledPayload {
  toolCallId: ToolCallId;
  assistantMessageId?: MessageId;
  toolName: string;
  input: unknown;
  dependencies?: ToolCallId[];
  parallelGroupIndex?: number;
  canRunParallel?: boolean;
  display?: ToolResultDisplayPayload;
  schedule: ToolSchedulePayload;
}

export interface ToolCallStartedPayload {
  toolCallId: ToolCallId;
  toolName?: string;
  startedAt: Date;
  display?: ToolResultDisplayPayload;
  /**
   * 这次调用**解析后**的副作用能力（工具元数据 + 按入参解析的运行时能力，例如 Bash 的只读命令判定）。
   * 事件在 handler 动手之前发出，所以订阅者能在第一个字节落盘前知道「要写了」——dynamic-workflow 的
   * driver 据此关闭 amend-resume 的导入缓存（`isWorkspaceMutatingToolCall`）。可选：早于本字段的事件没有。
   */
  readOnly?: boolean;
  sideEffectScope?: ToolSideEffectScope;
}

export interface ToolCallProgressPayload {
  toolCallId: ToolCallId;
  toolName?: string;
  elapsedMs?: number;
  /** MCP `notifications/progress`（A8）：progress / total / message 原样转发。 */
  progress?: number;
  total?: number;
  message?: string;
  pid?: number;
  stdoutBytes?: number;
  stderrBytes?: number;
  outputBytes?: number;
  outputPreview?: ExecutionOutputPreview;
  stdoutTail?: string;
  stderrTail?: string;
}

export interface ToolCallResultPayload {
  toolCallId: ToolCallId;
  result: ToolResultPayload;
  duration: number;
  /** Skill metadata 仅用于本地历史归属，不进入模型可见的 result.content，也不做任何上报。 */
  skillMetadata?: SkillTelemetryMetadata;
  /** 执行时 ToolEntry 的插件归属，不从工具名称推断。 */
  pluginId?: string;
}

export interface ToolCallErrorPayload {
  toolCallId: ToolCallId;
  error: ErrorPayload;
  /** Skill metadata 仅用于本地历史归属，不进入模型可见的错误正文，也不做任何上报。 */
  skillMetadata?: SkillTelemetryMetadata;
  /** 执行时 ToolEntry 的插件归属，不从工具名称推断。 */
  pluginId?: string;
}

export interface ToolBatchCompletePayload {
  toolCallIds: ToolCallId[];
  successCount: number;
  errorCount: number;
}

export type BackgroundTaskStatus =
  | "running"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "spawn_error"
  | "lost";

export interface BackgroundTaskPayloadBase {
  taskId: string;
  toolCallId?: ToolCallId | string;
  toolName?: string;
  // "workflow" = workflow run（CreateWorkflow）。追踪器的行为已按 per-tool lifecycleProvider
  // 分派，taskKind 只决定面板分组与图标，所以加宽是纯展示修正，不改任何生命周期语义。
  taskKind?: "bash" | "subagent" | "workflow";
  childSessionId?: SessionId | string;
  blocked?: boolean;
  blockedReason?: "interactive_prompt_detected" | "no_output_progress" | string;
  cancellable?: boolean;
  cancelRequestedAt?: Date;
  command?: string;
  description?: string;
  status: BackgroundTaskStatus;
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

export type BackgroundTaskStartedPayload = BackgroundTaskPayloadBase & { status: "running" };

export type BackgroundTaskUpdatedPayload = BackgroundTaskPayloadBase;

export type BackgroundTaskCompletedPayload = BackgroundTaskPayloadBase & {
  status: Exclude<BackgroundTaskStatus, "running">;
};

/**
 * 一条 workflow run 进度事件（父会话）。字段与 {@link DynamicWorkflowRunEvent} 同形——
 * **一次序列化、两个消费者**：`listEvents` 的事件页与这里的会话事件用同一个有界载荷，
 * 读端因此不需要两套解释规则。`type` 已被会话事件信封占用，故引擎事件种类叫 `eventType`。
 */
export interface DynamicWorkflowRunProgressPayload {
  runId: string;
  /** 发起这次 run 的 CreateWorkflow 工具调用（工具卡 → 详情页的关联键）。 */
  toolCallId?: ToolCallId | string;
  /** journal sequence（`appendEvent` 单调分配）；事件日志的 cursor 与它同一把尺。 */
  sequence: number;
  /** 引擎事件种类：run-started / actor-created / node-* / usage-updated / log / report / phase-entered / run-settled。 */
  eventType: string;
  payload: Record<string, unknown>;
  truncated?: boolean;
  /** 派生字段（toProgressPayload）：`actor-created` 上该子代理会话的 id（driver 铸的 `sess_dwf-…`）。 */
  actorSessionId?: string;
  /**
   * 派生字段（与 `actorSessionId` 同类，见 toProgressPayload）：该 run 的 `run-launched.inputId`。
   * 只挂在 `actor-created` / `run-settled` 两种事件上，供下游把子代理归到发起 run 的那一轮。升级前的 run 没有 `run-launched`，字段缺席。
   */
  launchInputId?: string;
}

export interface PermissionRequestedPayload {
  approvalMode?: "user-once";
  requestId?: string;
  toolCallId: ToolCallId;
  toolName: string;
  riskLevel: RiskLevel;
  reason: string;
  input: unknown;
  suggestedPermissionUpdates?: PermissionUpdate[];
  origin?: InteractionRequestOrigin;
  /**
   * 工具自报的确认预览，由 `prepareApproval` 钩子产出。复用结果通道的 display 投影，
   * 让 ask 与结果卡共享同一套有界形状，不新增无界字段。
   */
  display?: ToolResultDisplayPayload;
  fullAccessSupported?: boolean;
  optionsPolicy?: PermissionOptionsPolicy;
}

/** 订阅者以 (scopeId, generation) 标识沙箱实例；renderer 只投递给 generation 一致的实例。 */
export interface PluginUiResourceSubscriberRef {
  instance: import("@zcode/shared/mcp-apps").McpAppInstance;
  scopeId: string;
  generation: number;
}

export interface PluginUiResourceUpdatedPayload {
  pluginId: string;
  serverName: string;
  uri: string;
  subscribers: PluginUiResourceSubscriberRef[];
}

export interface PluginUiResourceListChangedPayload {
  pluginId: string;
  serverName: string;
  subscribers: PluginUiResourceSubscriberRef[];
}

/** App-Provided Tools：一次待执行的页面工具调用，投递给 subscribers 里唯一的实例。 */
export interface PluginUiAppToolCallRequestedPayload {
  activity?: boolean;
  cancelled?: boolean;
  pluginId: string;
  serverName: string;
  subscribers: PluginUiResourceSubscriberRef[];
  callId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

export interface PermissionResolvedPayload {
  requestId?: string;
  toolCallId: ToolCallId;
  decision: PermissionDecision;
  reason?: string;
  modifiedInput?: unknown;
}

export interface PermissionDeniedPayload {
  toolCallId: ToolCallId;
  toolName: string;
  reason: string;
  inputSummary?: unknown;
}

export type UserInputAutoResolutionState =
  | {
      state: "hiddenGrace" | "visibleCountdown";
      startedAt: number;
      visibleAt: number;
      deadlineAt: number;
    }
  | { state: "snoozed"; startedAt: number; snoozedAt: number };

export interface UserInputAutoResolutionUpdatedPayload {
  interactionId: string;
  toolCallId: ToolCallId;
  autoResolution: UserInputAutoResolutionState;
}

export interface WorkspaceHookReviewRequestedPayload {
  request: unknown;
}

export interface WorkspaceHookReviewSettledPayload {
  interactionId: string;
  state: "resolved" | "timed_out" | "configuration_error";
  reasonCode?: string;
}

export interface WorkspaceHookReviewSupersededPayload {
  interactionId: string;
  supersededByInteractionId: string;
}

// 软门禁:准入层完成评估后上报 pending 状态。
// pendingCount = configuredEnabled && admissionClass === "pending" 的声明数;
// pendingCount === 0 → 投影层将 snapshot.workspaceHookAdmission 置 null(提示条消失)。
export interface WorkspaceHookAdmissionUpdatedPayload {
  pendingCount: number;
  bundleDigest: string;
  workspaceIdentity?: string;
}

/** MCP 的声明集合摘要仅供提示去重；逐条授权仍使用各自的 declarationDigest。 */
export interface WorkspaceMcpAdmissionUpdatedPayload {
  pendingCount: number;
  bundleDigest: string;
  workspaceIdentity?: string;
}
