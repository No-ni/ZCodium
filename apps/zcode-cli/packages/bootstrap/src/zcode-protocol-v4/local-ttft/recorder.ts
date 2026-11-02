// 上游把 local-ttft.ts 拆成 local-ttft/ 目录，helper 仍在上一层；这里按新位置取 `../`，
// 同时保留本仓额外使用的 streamingParentToolCallId / turnTerminalState（回合终态判定修复）。
import { streamingParentToolCallId, turnTerminalState } from "../local-ttft-events.js";
import { observeLocalTtftCompaction } from "../local-ttft-compaction.js";
import { LocalTtftClockWatch } from "../local-ttft-clock.js";
import { applyModelNetworkAttempt } from "./model-attempt.js";
import {
  SessionEventType,
  observeLocalTurnPreparation,
  type SessionEvent,
  type ModelStreamingPayload,
  type ModelNetworkStatusPayload,
  type TurnStartedPayload,
  type TurnCompletePayload,
  type TurnErrorPayload,
  type TurnSteerQueuedPayload,
  type TurnSteerDrainedPayload,
  type TurnSteerDiscardedPayload,
} from "@zcode/contracts";
// streamingParentToolCallId 已由上面的 local-ttft-events 提供（两处同源，只取一次避免重复标识符）。
import { randomUUID } from "node:crypto";
import {
  LOCAL_TTFT_MAX_PENDING,
  LOCAL_TTFT_MAX_DETAILS,
  LOCAL_TTFT_TTL_MS,
  localTtftNow,
  type CommandEnvelope,
  type LocalTtftFacts,
  type LocalTtftOutputKind,
} from "@zcode/shared/zcode-protocol-v4";

/** 无业务裁决权：只跟随 inbox 和 live event，不建立第二份 accepted input queue。 */
export class LocalTtftRecorder {
  readonly instanceId = randomUUID();
  private clockWatch?: LocalTtftClockWatch;
  private readonly preparationSubscriptions = new Map<string, () => void>();
  private readonly requestState = new Map<string, "response" | "preparation" | "failed">();
  private readonly queueSources = new Map<string, string>();
  private readonly checkpointSignatures = new Map<string, string>();
  private readonly completed = new Map<string, LocalTtftFacts>();
  private readonly records = new Map<string, LocalTtftFacts>();
  constructor(
    private readonly now: () => number = localTtftNow,
    private readonly onDrop: () => void = () => {},
    private readonly onCheckpoint: (facts: LocalTtftFacts) => void = () => {},
  ) {}

  receive(envelope: CommandEnvelope, busy: boolean): boolean {
    this.prune();
    if (
      !envelope.ttft ||
      this.records.has(envelope.commandId) ||
      this.completed.has(envelope.commandId)
    )
      return true;
    if (this.records.size >= LOCAL_TTFT_MAX_PENDING) return false;
    this.records.set(envelope.commandId, {
      ...envelope.ttft,
      instanceId: this.instanceId,
      commandId: envelope.commandId,
      ...(envelope.sessionId ? { sessionId: envelope.sessionId } : {}),
      receivedAt: this.now(),
      sendMode: busy ? "queued" : "idle",
      details: [],
    });
    // admission/冷恢复可能一直等待，收到命令就发检查点，避免只有受理成功才留下线索。
    this.checkpoint(this.records.get(envelope.commandId)!);
    this.clockWatch ??= new LocalTtftClockWatch(this.now, (unreliable) => {
      if (unreliable)
        for (const record of this.records.values()) {
          if (record.outputAt === undefined) {
            record.clockInvalid = true;
            this.checkpoint(record);
          }
        }
      this.prune();
      if (!this.records.size) {
        this.clockWatch?.dispose();
        this.clockWatch = undefined;
      }
    });
    this.preparationSubscriptions.set(
      envelope.commandId,
      observeLocalTurnPreparation(envelope.commandId, (fact) => {
        const record = this.records.get(envelope.commandId);
        if (
          !record ||
          (record.sessionId && record.sessionId !== fact.sessionId) ||
          (record.turnId && record.turnId !== fact.turnId)
        )
          return;
        record.sessionId = fact.sessionId;
        record.turnId = fact.turnId;
        if (fact.stage === "execution") record.executionAt ??= fact.start;
        else {
          const details = (record.details ??= []);
          const index = details.findIndex((detail) => detail.id === fact.id);
          const detail = {
            id: fact.id,
            stage: fact.stage,
            start: fact.start,
            end: fact.end,
            outcome: fact.outcome,
            source: "cli" as const,
          };
          if (index >= 0) details[index] = detail;
          else if (details.length < LOCAL_TTFT_MAX_DETAILS) details.push(detail);
          else record.truncated = true;
        }
        this.checkpoint(record);
      }),
    );
    return true;
  }
  private checkpoint(record: LocalTtftFacts): void {
    const signature = JSON.stringify({ ...record, revision: undefined });
    if (this.checkpointSignatures.get(record.commandId) === signature) return;
    this.checkpointSignatures.set(record.commandId, signature);
    record.revision = (record.revision ?? 0) + 1;
    try {
      this.onCheckpoint({ ...record, details: record.details?.map((detail) => ({ ...detail })) });
    } catch {
      /* 导出不可影响业务。 */
    }
  }
  admitted(commandId: string): void {
    const record = this.records.get(commandId);
    if (record) {
      record.admittedAt ??= this.now();
      this.checkpoint(record);
    }
  }
  event(sessionId: string, event: SessionEvent): void {
    if (!this.records.size) return;
    this.queueEvent(sessionId, event);
    if (
      event.type === SessionEventType.CompactStarted ||
      event.type === SessionEventType.CompactCompleted ||
      event.type === SessionEventType.CompactFailed
    ) {
      const current = this.forSession(sessionId);
      if (current && observeLocalTtftCompaction(current, event, this.now()))
        this.checkpoint(current);
    }
    this.observeLifecycle(sessionId, event);
    if (event.type === SessionEventType.ModelNetworkStatus) {
      const payload = event.payload as ModelNetworkStatusPayload;
      const record = this.forSession(sessionId);
      if (record && payload.modelCall) {
        if (record.requestId === payload.requestId)
          record.logicalCallId = payload.modelCall.logicalCallId;
        const attempt = record.details?.find(
          (detail) => detail.requestId === payload.requestId && detail.stage === "attempt",
        );
        if (attempt) attempt.logicalCallId = payload.modelCall.logicalCallId;
        this.checkpoint(record);
      }
    }
    if (event.type === SessionEventType.ModelStreaming) {
      const payload = event.payload as ModelStreamingPayload;
      // 空 block/start 没有可展示内容；只接受本轮主模型流中的非空增量。
      if (streamingParentToolCallId(event.payload as Record<string, unknown>)) return;
      if (payload.kind === "tool_call" && payload.toolName?.trim()) {
        this.output(sessionId, event.turnId ? String(event.turnId) : undefined, "tool");
        return;
      }
      if (!payload.delta?.trim()) return;
      const kind =
        payload.kind === "text_delta"
          ? "text"
          : payload.kind === "reasoning_delta"
            ? "reasoning"
            : payload.kind === "tool_input_delta"
              ? "tool"
              : undefined;
      if (kind) this.output(sessionId, event.turnId ? String(event.turnId) : undefined, kind);
    }
  }
  private queueEvent(sessionId: string, event: SessionEvent): void {
    if (event.type === SessionEventType.TurnSteerQueued) {
      const payload = event.payload as TurnSteerQueuedPayload;
      const commandId = payload.intent?.sourceCommandId ?? payload.inputId;
      const record = commandId ? this.records.get(commandId) : undefined;
      if (record && (!record.sessionId || record.sessionId === sessionId)) {
        record.sessionId = sessionId;
        record.sendMode = "queued";
        this.queueSources.set(payload.pendingInputId, record.commandId);
        this.checkpoint(record);
      }
    }
    if (event.type === SessionEventType.TurnSteerDrained) {
      const payload = event.payload as TurnSteerDrainedPayload;
      for (const input of payload.drainedInputs ?? []) {
        if (input.delivery !== "guide") continue;
        const commandId =
          input.intent?.sourceCommandId ?? this.queueSources.get(input.pendingInputId);
        const record = commandId ? this.records.get(commandId) : undefined;
        if (record?.sessionId === sessionId) {
          record.sendMode = "guided";
          this.checkpoint(record);
          this.retire(record);
        }
      }
    }
    if (event.type === SessionEventType.TurnSteerDiscarded) {
      const payload = event.payload as TurnSteerDiscardedPayload;
      if (payload.reason === "promoted") return;
      for (const id of payload.pendingInputIds) {
        const commandId = this.queueSources.get(id);
        const record = commandId ? this.records.get(commandId) : undefined;
        if (record?.sessionId === sessionId) {
          record.terminal = payload.reason === "turn_failed" ? "failed" : "cancelled";
          this.checkpoint(record);
          this.retire(record);
        }
      }
    }
  }
  private observeLifecycle(sessionId: string, event: SessionEvent): void {
    this.prune();
    const turnId = event.turnId ? String(event.turnId) : undefined;
    if (event.type === SessionEventType.TurnStarted) {
      const payload = event.payload as TurnStartedPayload;
      const record = payload.inputId ? this.records.get(payload.inputId) : undefined;
      if (!record || (record.sessionId && record.sessionId !== sessionId)) return;
      record.sessionId = sessionId;
      record.turnId = turnId;
      record.executionAt ??= payload.executionStartedAt;
      this.checkpoint(record);
      return;
    }
    const terminal =
      event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError;
    const inputId = terminal
      ? (event.payload as TurnCompletePayload | TurnErrorPayload).inputId
      : undefined;
    const record = inputId
      ? this.records.get(inputId)
      : [...this.records.values()].find(
          (item) => item.sessionId === sessionId && item.turnId === turnId,
        );
    if (!record || record.sessionId !== sessionId) return;
    if (record.turnId === undefined && terminal) record.turnId = turnId;
    if (record.turnId !== turnId) return;
    // querySource 守卫不命中时 helper 返回 false，须连同下方 checkpoint/output/terminal 一起 early return。
    if (
      event.type === SessionEventType.ModelNetworkStatus &&
      record.outputAt === undefined &&
      !applyModelNetworkAttempt(
        record,
        event.payload as ModelNetworkStatusPayload,
        this.requestState,
        this.now,
      )
    )
      return;
    this.checkpoint(record);
    if (
      event.type === SessionEventType.ToolCallScheduled &&
      !streamingParentToolCallId(event.payload as Record<string, unknown>)
    )
      this.output(sessionId, turnId, "tool");
    if (terminal) {
      record.terminal = turnTerminalState(event);
      this.checkpoint(record);
      this.retire(record);
    }
  }
  output(sessionId: string, turnId: string | undefined, kind: LocalTtftOutputKind): void {
    for (const record of this.records.values()) {
      if (
        this.requestState.get(record.commandId) === "failed" ||
        this.requestState.get(record.commandId) === "preparation"
      )
        continue;
      if (
        record.sessionId === sessionId &&
        record.turnId === turnId &&
        record.requestAt !== undefined &&
        record.outputAt === undefined
      ) {
        record.outputAt = this.now();
        record.outputKind = kind;
        this.preparationSubscriptions.get(record.commandId)?.();
        this.preparationSubscriptions.delete(record.commandId);
        const attempt = record.details?.find(
          (detail) => detail.id === `attempt:${record.requestId}`,
        );
        if (attempt && attempt.end === undefined) {
          attempt.end = record.outputAt;
          attempt.outcome = "first_output";
        }
        // 旁路仅证明 CLI 已有有效输出；Renderer 仍须收到实际内容帧才收口。
        this.checkpoint(record);
      }
      if (
        record.sessionId === sessionId &&
        record.turnId === turnId &&
        record.requestAt !== undefined &&
        kind === "text"
      )
        this.retire(record);
    }
  }
  private retire(record: LocalTtftFacts): void {
    // 首正文/terminal 后不再归一逐 token 事件；保留有界末态供实际帧扇出。
    this.forget(record.commandId);
    this.records.delete(record.commandId);
    if (!this.records.size) {
      this.clockWatch?.dispose();
      this.clockWatch = undefined;
    }
    this.completed.set(record.commandId, record);
    if (this.completed.size > LOCAL_TTFT_MAX_PENDING) {
      this.completed.delete(this.completed.keys().next().value!);
      try {
        this.onDrop();
      } catch {
        /* 丢弃诊断不能影响用户任务。 */
      }
    }
  }
  forSession(sessionId: string, commandId?: string): LocalTtftFacts | undefined {
    this.prune();
    return [...this.completed.values(), ...this.records.values()]
      .reverse()
      .find(
        (record) =>
          record.sessionId === sessionId &&
          (commandId ? record.commandId === commandId : record.turnId !== undefined),
      );
  }
  clear(): void {
    this.clockWatch?.dispose();
    this.clockWatch = undefined;
    for (const off of this.preparationSubscriptions.values()) off();
    this.preparationSubscriptions.clear();
    this.records.clear();
    this.requestState.clear();
    this.queueSources.clear();
    this.checkpointSignatures.clear();
    this.completed.clear();
  }
  private forget(commandId: string): void {
    this.preparationSubscriptions.get(commandId)?.();
    this.preparationSubscriptions.delete(commandId);
    this.requestState.delete(commandId);
    this.checkpointSignatures.delete(commandId);
    for (const [id, source] of this.queueSources)
      if (source === commandId) this.queueSources.delete(id);
  }
  private prune(): void {
    const now = this.now();
    for (const records of [this.records, this.completed])
      for (const [key, record] of records)
        if (now - record.receivedAt > LOCAL_TTFT_TTL_MS) {
          this.forget(key);
          records.delete(key);
        }
  }
}
