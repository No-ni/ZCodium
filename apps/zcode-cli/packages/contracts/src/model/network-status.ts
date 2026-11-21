import {
  ModelTransportKind,
  ModelFailureReason,
  ModelErrorCode,
  ModelRetryReason,
} from "../protocol-values/contract.js";
import type {
  ModelRequestTarget,
  ModelProviderId,
  ModelId,
  ModelUsage,
} from "../protocol-values/contract.js";
// ============================================================
// Model Protocol - provider-neutral model contracts
// ============================================================
import type { QueryId, SessionId, TraceId, TurnId } from "../interfaces/shared.js";
import type { ModelApiErrorPhase, ResolvedModelApiCallObservation } from "../model/observation.js";

/**
 * 一次模型请求尝试的准入票据（runtime-only）。
 *
 * 它同时是**这一次尝试**的状态事件汇：runner 把该尝试的 ModelNetworkStatus 事件
 * （`model_request_started` / `model_request_completed` / `model_request_failed` /
 * `model_retry_scheduled`）原样也投递给它，治理器据此判定这次请求的结果（成功 / 限流 / 瞬态失败 /
 * 终结），不需要 runner 在每个失败分支上另写一遍结果。`release()` 是兜底：尝试无论如何结束（成功、
 * 抛出、消费者提前放弃流）runner 都在 finally 里调一次；未见终结事件即按终结处理。**幂等**。
 */
export interface ModelRequestAdmissionTicket extends ModelStatusSink {
  release(): void;
}

/**
 * 模型请求的准入端口（runtime-only）。runner 在**每一次尝试发出前**先试同步快路径
 * `tryAcquire`，未命中再 `acquire` 排队；拿到票据后才发请求；尝试结束即 `release`，退避 sleep 期间
 * 不持票——所以进程级并发 cap 约束的是 provider 真正看到的在飞请求数。`signal` 被 abort 时
 * `acquire` 以 `signal.reason` reject。
 *
 * `tryAcquire` 未命中是 runner 发 `model_request_queued` / `model_request_admitted` 的唯一依据
 * 没有快路径的实现 runner 无法分辨「排了队」与「立即放行」，一律不发这两条事件。
 *
 * 端口绑定在 runtime 的模型工厂上：runtime 交出的每一个模型句柄——turn step、工具内部
 * 的模型调用、压缩、标题 sidecar——都带它；缺席即不设闸门（runner 行为逐字不变）。主代理拿的是
 * 治理器的 observer 实现：`tryAcquire` 总命中、只喂信号。
 */
export interface ModelRequestAdmission {
  /** 同步快路径：闸门开着且无人排队即给票；否则 undefined，runner 转 `acquire` 并报排队。 */
  tryAcquire?(input: { model: ModelRequestTarget }): ModelRequestAdmissionTicket | undefined;
  acquire(input: {
    model: ModelRequestTarget;
    signal?: AbortSignal;
  }): Promise<ModelRequestAdmissionTicket>;
}

interface ModelNetworkStatusBase {
  timestamp: string;
  traceId: TraceId;
  queryId?: QueryId;
  sessionId?: SessionId;
  turnId?: TurnId;
  parentSessionId?: SessionId;
  toolCallId?: string;
  spanId?: string;
  parentSpanId?: string;
  querySource?: string;
  requestId: string;
  providerId: ModelProviderId;
  modelId: ModelId;
  baseURL?: string;
  providerKind?: string;
  transport: ModelTransportKind;
  attempt: number;
  /**
   * 本次请求的重试预算总尝试数（含首次）。**`0` = 无上限**（`ModelRetryBudget.Unbounded`）：`Infinity` 不可序列化，而 0 不占用任何既有合法值。
   * 消费方渲染「第 n/N 次」或推导 maxRetries 时必须特判 0。
   */
  maxAttempts: number;
  streamRecovery?: ModelStreamRecoveryStatus;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestHeaderCount?: number;
  responseHeaderCount?: number;
  modelCall?: ResolvedModelApiCallObservation;
}

export interface ModelStreamRecoveryStatus {
  attemptId: string;
  retryNumber: number;
  maxRetries: number;
  recoveredFromRequestId?: string;
  anchorId?: string;
}

export interface ModelRequestStartedStatusEvent extends ModelNetworkStatusBase {
  type: "model_request_started";
}

/**
 * 准入等待的两端：runner 的 `tryAcquire` 未命中
 * 即发 `queued`，拿到票即发 `admitted`（带排队时长）。它们是 runtime 观测——driver 据此报「等待槽位」，
 * 工具执行器据此暂停工具超时——不进 provider 请求；协议侧凡枚举状态类型的消费方显式忽略。
 */
export interface ModelRequestQueuedStatusEvent extends ModelNetworkStatusBase {
  type: "model_request_queued";
}

export interface ModelRequestAdmittedStatusEvent extends ModelNetworkStatusBase {
  type: "model_request_admitted";
  queuedMs: number;
}

export interface ModelRequestCompletedStatusEvent extends ModelNetworkStatusBase {
  type: "model_request_completed";
  durationMs: number;
  finishReason?: string;
  usage?: ModelUsage;
  providerRequestId?: string;
  timeToFirstProviderEventMs?: number;
  timeToFirstContentMs?: number;
  timeToFirstTextMs?: number;
  streamMaxIdleMs?: number;
  streamStallCount?: number;
  streamOutputCommitted?: boolean;
}

export interface ModelRequestFailedStatusEvent extends ModelNetworkStatusBase {
  type: "model_request_failed";
  /** Provider 已报告的失败请求用量；不为失败响应伪造成功完成事件。 */
  usage?: ModelUsage;
  durationMs?: number;
  reason: ModelFailureReason;
  retryable: boolean;
  message: string;
  statusCode?: number;
  errorCode?: ModelErrorCode;
  providerErrorCode?: string;
  providerErrorMessage?: string;
  providerRequestId?: string;
  retryAfterMs?: number;
  errorPhase?: ModelApiErrorPhase;
  exceptionType?: string;
  streamOutputCommitted?: boolean;
}

export interface ModelRetryScheduledStatusEvent extends ModelNetworkStatusBase {
  type: "model_retry_scheduled";
  delayMs: number;
  nextAttempt: number;
  reason: ModelRetryReason;
  message: string;
  statusCode?: number;
  errorCode?: ModelErrorCode;
  providerErrorCode?: string;
  providerErrorMessage?: string;
  providerRequestId?: string;
  retryAfterMs?: number;
}

export interface ModelStreamStalledStatusEvent extends ModelNetworkStatusBase {
  type: "model_stream_stalled";
  idleMs: number;
  timeoutMs: number;
  message: string;
}

/** 仅投递进程内 telemetry statusSink，不进入请求 UI 事件；字段不得携带凭据或用户内容。 */
export type ModelRequestObservation = Readonly<{
  kind: string;
  [field: string]: string | number | boolean | undefined;
}>;

export interface ModelRequestObservationStatusEvent extends ModelNetworkStatusBase {
  type: "model_request_observation";
  observation: ModelRequestObservation;
}

export type ModelNetworkStatusEvent =
  | ModelRequestQueuedStatusEvent
  | ModelRequestAdmittedStatusEvent
  | ModelRequestObservationStatusEvent
  | ModelRequestStartedStatusEvent
  | ModelRequestCompletedStatusEvent
  | ModelRequestFailedStatusEvent
  | ModelRetryScheduledStatusEvent
  | ModelStreamStalledStatusEvent;

export interface ModelStatusSink {
  publish(event: ModelNetworkStatusEvent): void | Promise<void>;
}
