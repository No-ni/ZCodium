// V4 已提交命令的 renderer 持久账本。
// 它只保存客户端恢复线索，不参与 conversation projection，也绝不能据此自动重放。
import type {
  CommandAck,
  CommandEnvelope,
  CommandsQueryResult,
  ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";
import {
  resolvePendingCommandWorkspaceKey,
  type PendingCommandClientContext,
} from "@/v4/pendingCommandWorkspace.js";
import { pendingCommandReplayFor } from "@/v4/pendingCommandReplay.js";
import {
  acceptPendingComposer,
  ownsPendingCommandDraft,
  rejectPendingComposer,
} from "@/v4/pendingCommandComposer.js";
import { markPendingTaskDraftCommand } from "@/v4/composer/composerDraftStore.js";
import {
  browserStorage,
  buildPendingReplayRequest,
  findSnapshotSettlements,
  hasPendingEntriesForSession,
  isEntry,
  isRuntimeLocalDiscard,
  keyOf,
  PENDING_COMMAND_TTL_MS,
  STORAGE_KEY,
} from "@/v4/pendingCommandRegistryHelpers.js";
import type {
  PendingCommandEntry,
  PendingCommandRecoveryReason,
  PendingCommandReplayRequest,
  PendingCommandRegistryOptions,
  PendingCommandResolution,
  QueryCommands,
  StorageLike,
} from "@/v4/pendingCommandRegistryTypes.js";
export type { PendingCommandReplay } from "@/v4/pendingCommandReplay.js";
export { PENDING_COMMAND_TTL_MS } from "@/v4/pendingCommandRegistryHelpers.js";
export type {
  PendingCommandEntry,
  PendingCommandRecoveryReason,
  PendingCommandReplayRequest,
  PendingCommandRegistryOptions,
  PendingCommandResolution,
} from "@/v4/pendingCommandRegistryTypes.js";

/**
 * ACK、queue 与 transcript 曾分别维护临时状态；renderer 刷新或 ACK 丢失后，
 * UI 已清空但无法证明 CLI 是否 admission。这里把“待对账线索”先于上行持久化，并用
 * queue/guided/transcript sourceCommandId 或显式终态收口；registry 本身永远不产生权威事实。
 */
export class PendingCommandRegistry {
  private readonly storage: StorageLike | undefined;
  private readonly now: () => number;
  private readonly entries = new Map<string, PendingCommandEntry>();
  private readonly listeners = new Set<() => void>();
  private readonly resolutionListeners = new Map<
    string,
    Set<(resolution: PendingCommandResolution) => void>
  >();
  private readonly reconcileInFlight = new Map<string, Promise<void>>();
  private queryBatchDepth = 0;
  private queryBatchChanged = false;

  constructor(options: PendingCommandRegistryOptions = {}) {
    this.storage = options.storage ?? browserStorage();
    this.now = options.now ?? Date.now;
    this.load();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeResolution(
    commandId: string,
    listener: (resolution: PendingCommandResolution) => void,
  ): () => void {
    const listeners = this.resolutionListeners.get(commandId) ?? new Set();
    listeners.add(listener);
    this.resolutionListeners.set(commandId, listeners);
    return () => {
      const current = this.resolutionListeners.get(commandId);
      current?.delete(listener);
      if (current?.size === 0) this.resolutionListeners.delete(commandId);
    };
  }

  record(
    envelope: CommandEnvelope,
    clientContext?: PendingCommandClientContext,
  ): PendingCommandEntry | null {
    this.pruneExpired();
    const replay = pendingCommandReplayFor(envelope);
    if (!replay) return null;
    const key = keyOf(envelope.sessionId, envelope.commandId);
    const existing = this.entries.get(key);
    if (existing) return existing;
    const entry: PendingCommandEntry = {
      commandId: envelope.commandId,
      clientId: envelope.clientId,
      sessionId: envelope.sessionId,
      issuedAt: envelope.issuedAt,
      // TTL 锚定首次登记时间；reload/reconcile 不得续期。
      expiresAt: this.now() + PENDING_COMMAND_TTL_MS,
      replay,
      ...(clientContext ? { clientContext } : {}),
    };
    this.entries.set(key, entry);
    const composer = clientContext?.composer;
    // 首发恢复线索必须先持久化；失败时拒绝上行，不能留下无法查询的待发送身份。
    if (!this.commit() && composer?.draftId) {
      this.entries.delete(key);
      throw new Error("composer.draft-storage-unavailable");
    }
    try {
      if (composer?.draftId)
        markPendingTaskDraftCommand(
          composer.scope,
          composer.draftId,
          envelope.commandId,
          envelope.sessionId,
        );
    } catch (error) {
      this.entries.delete(key);
      this.commit();
      throw error;
    }
    return entry;
  }

  list(sessionId: string | null): readonly PendingCommandEntry[] {
    this.pruneExpired();
    return [...this.entries.values()]
      .filter((entry) => entry.sessionId === sessionId)
      .sort((left, right) => left.issuedAt - right.issuedAt);
  }

  findCommand(commandId: string): PendingCommandEntry | undefined {
    return [...this.entries.values()].find((entry) => entry.commandId === commandId);
  }

  listRecoverable(sessionId: string | null): readonly PendingCommandEntry[] {
    return this.list(sessionId).filter(
      // 兼容 V4 初版已经写入 localStorage 的 unknown：它不是可操作错误，不能再进入 UI。
      (entry) => entry.recovery === "discarded" && !entry.recoveryDismissed,
    );
  }

  settle(sessionId: string | null, commandId: string): void {
    if (!this.entries.delete(keyOf(sessionId, commandId))) return;
    this.commit();
  }

  rejectCommand(sessionId: string | null, commandId: string): void {
    const entry = this.entries.get(keyOf(sessionId, commandId));
    if (entry) this.rejectComposer(entry);
    this.settle(sessionId, commandId);
  }

  dismissRecovery(sessionId: string | null, commandId: string): void {
    const key = keyOf(sessionId, commandId);
    const entry = this.entries.get(key);
    if (!entry?.recovery || entry.recoveryDismissed) return;
    this.entries.set(key, { ...entry, recoveryDismissed: true });
    this.commit();
  }

  applyAck(envelope: CommandEnvelope, ack: CommandAck): void {
    let entry = this.entries.get(keyOf(envelope.sessionId, envelope.commandId));
    if (!entry) return;
    if (entry.replay.kind === "sensitiveDigest") {
      // 交互答案不可重放；拿到确定 ACK 后其对账职责已结束。
      this.settle(entry.sessionId, entry.commandId);
      return;
    }
    entry = this.remapCreatedSession(entry, ack);
    if (ack.status === "accepted" || ack.status === "duplicate") {
      if (!this.acceptComposer(entry)) return;
      this.clearRecovery(entry);
      this.notifyResolution(entry.commandId, ack.status);
      return;
    }
    if (ack.status === "failed" && ack.reasonCode === "fault.command.inputDiscardedOnRestart") {
      this.rejectComposer(entry);
      if (isRuntimeLocalDiscard(ack)) {
        this.notifyResolution(entry.commandId, "discarded");
        this.settle(entry.sessionId, entry.commandId);
        return;
      }
      this.notifyResolution(entry.commandId, "failed");
      this.markRecovery(entry, "discarded");
      return;
    }
    this.rejectComposer(entry);
    this.notifyResolution(entry.commandId, "failed");
    this.settle(entry.sessionId, entry.commandId);
  }

  applyQuery(result: CommandsQueryResult): void {
    // 一次查询最多返回 64 项；逐项 commit 会重复序列化整份账本并通知所有 pane。
    // 只合并同步响应处理，不能跨 await 延迟新命令的「先持久化、再上行」。
    this.queryBatchDepth += 1;
    try {
      this.applyQueryResults(result);
    } finally {
      this.queryBatchDepth -= 1;
      if (this.queryBatchDepth === 0 && this.queryBatchChanged) {
        // 先退出批次再通知，保证订阅回调重入 record/ACK/query 时仍立即持久化。
        this.queryBatchChanged = false;
        this.commit();
      }
    }
  }

  private applyQueryResults(result: CommandsQueryResult): void {
    for (const item of result.results) {
      let entry = this.entries.get(keyOf(item.key.sessionId, item.key.commandId));
      if (!entry) continue;
      if (item.result === "unknown") {
        // 查询可能越过仍在 Host 准备的发送；未命中不是拒绝。提前清账会恢复已发送正文，
        // 并丢掉迟到 ACK 的结算订阅。保留线索，交给明确结果、权威投影或既有 TTL 收口。
        continue;
      }
      if (
        item.result.status === "failed" &&
        item.result.reasonCode === "fault.command.queryUnavailable"
      ) {
        continue;
      }
      if (
        item.result.status === "failed" &&
        item.result.reasonCode === "fault.command.inputDiscardedOnRestart"
      ) {
        this.rejectComposer(entry);
        if (isRuntimeLocalDiscard(item.result)) {
          this.notifyResolution(entry.commandId, "discarded");
          this.settle(entry.sessionId, entry.commandId);
          continue;
        }
        this.notifyResolution(entry.commandId, "failed");
        this.markRecovery(entry, "discarded");
        continue;
      }
      entry = this.remapCreatedSession(entry, item.result);
      if (entry.replay.kind === "sensitiveDigest") {
        this.settle(entry.sessionId, entry.commandId);
        continue;
      }
      if (item.result.status === "accepted" || item.result.status === "duplicate") {
        if (!this.acceptComposer(entry)) continue;
        this.clearRecovery(entry);
        this.notifyResolution(entry.commandId, item.result.status);
      } else {
        this.rejectComposer(entry);
        this.notifyResolution(entry.commandId, "failed");
        this.settle(entry.sessionId, entry.commandId);
      }
    }
  }

  reconcileSnapshot(snapshot: ConversationSnapshot, workspaceKey?: string): void {
    // Bug 根因：每个流式帧都会逐行扫描全部历史来收集 sourceCommandId。只有本会话还有待对账条目、
    // 或有人在等某个命令的结算时，扫描才可能产生效果；两者都没有时直接返回，结果不变。
    if (
      this.resolutionListeners.size === 0 &&
      !hasPendingEntriesForSession(this.entries.values(), snapshot.sessionId)
    )
      return;
    const settlements = findSnapshotSettlements(this.entries.values(), snapshot, workspaceKey);
    if (!settlements) return;
    const { candidates, settled } = settlements;
    let changed = false;
    for (const commandId of settled) {
      let entry = candidates.get(commandId);
      if (!entry) continue;
      if (entry.sessionId === null) {
        // 快照可先于 ACK；先绑定原 workspace 的创建，订阅才能读取正确 sessionId。
        this.entries.delete(keyOf(null, commandId));
        entry = { ...entry, sessionId: snapshot.sessionId };
        this.entries.set(keyOf(snapshot.sessionId, commandId), entry);
        changed = true;
      }
      if (!this.acceptComposer(entry)) continue;
      this.notifyResolution(commandId, "authoritative");
      changed = this.entries.delete(keyOf(snapshot.sessionId, commandId)) || changed;
    }
    if (changed) this.commit();
  }

  private acceptComposer(entry: PendingCommandEntry): boolean {
    return acceptPendingComposer(entry, this.storage);
  }

  private rejectComposer(entry: PendingCommandEntry): void {
    rejectPendingComposer(entry);
  }

  reconcileSession(
    sessionId: string | null,
    query: QueryCommands,
    workspaceKey?: string,
  ): Promise<void> {
    const inFlightKey = JSON.stringify([workspaceKey, sessionId]);
    const existing = this.reconcileInFlight.get(inFlightKey);
    if (existing) return existing;
    const pending = this.runReconcile(sessionId, query, workspaceKey).finally(() => {
      if (this.reconcileInFlight.get(inFlightKey) === pending) {
        this.reconcileInFlight.delete(inFlightKey);
      }
    });
    this.reconcileInFlight.set(inFlightKey, pending);
    return pending;
  }

  consumeReplay(key: {
    sessionId: string | null;
    commandId: string;
  }): PendingCommandReplayRequest | null {
    const entry = this.entries.get(keyOf(key.sessionId, key.commandId));
    if (!entry || entry.replay.kind !== "input") return null;
    const request = buildPendingReplayRequest(entry.replay, entry.sessionId, entry.clientContext);
    // 用户已确认以新 commandId 重发，旧 discarded 线索在本地完成收口。
    this.rejectComposer(entry);
    this.settle(entry.sessionId, entry.commandId);
    return request;
  }

  private async runReconcile(
    sessionId: string | null,
    query: QueryCommands,
    workspaceKey?: string,
  ): Promise<void> {
    // null bucket 会收集各 workspace 的创建；只能向命令原属 Agent 查询。
    const entries = this.list(sessionId).filter(
      (entry) =>
        workspaceKey === undefined ||
        resolvePendingCommandWorkspaceKey(entry) === workspaceKey ||
        (sessionId !== null && resolvePendingCommandWorkspaceKey(entry) === null),
    );
    for (let offset = 0; offset < entries.length; offset += 64) {
      const batch = entries.slice(offset, offset + 64);
      const result = await query({
        commands: batch.map((entry) => ({
          sessionId: entry.sessionId,
          commandId: entry.commandId,
        })),
      });
      this.applyQuery(result);
    }
  }

  private markRecovery(entry: PendingCommandEntry, recovery: PendingCommandRecoveryReason): void {
    if (entry.recovery === recovery) return;
    this.entries.set(keyOf(entry.sessionId, entry.commandId), {
      ...entry,
      recovery,
      recoveryDismissed: false,
    });
    this.commit();
  }

  private clearRecovery(entry: PendingCommandEntry): void {
    if (!entry.recovery && !entry.recoveryDismissed) return;
    const { recovery: _recovery, recoveryDismissed: _dismissed, ...settled } = entry;
    this.entries.set(keyOf(entry.sessionId, entry.commandId), settled);
    this.commit();
  }

  private remapCreatedSession(entry: PendingCommandEntry, ack: CommandAck): PendingCommandEntry {
    if (
      entry.replay.kind !== "input" ||
      entry.replay.type !== "createSession" ||
      (ack.status !== "accepted" && ack.status !== "duplicate") ||
      ack.result?.type !== "createSession" ||
      entry.sessionId === ack.result.sessionId
    ) {
      return entry;
    }
    this.entries.delete(keyOf(entry.sessionId, entry.commandId));
    const remapped = { ...entry, sessionId: ack.result.sessionId };
    this.entries.set(keyOf(remapped.sessionId, remapped.commandId), remapped);
    this.commit();
    return remapped;
  }

  private load(): void {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return;
      for (const value of parsed) {
        if (isEntry(value)) {
          this.entries.set(keyOf(value.sessionId, value.commandId), value);
        }
      }
      this.pruneExpired();
    } catch {
      // storage 损坏不能阻断聊天；丢弃的是客户端恢复线索，不影响 CLI 权威事实。
      this.entries.clear();
    }
  }

  private ownsPendingDraft(entry: PendingCommandEntry): boolean {
    return ownsPendingCommandDraft(entry);
  }

  private pruneExpired(): void {
    const now = this.now();
    let changed = false;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now && !this.ownsPendingDraft(entry)) {
        this.entries.delete(key);
        changed = true;
      }
    }
    if (changed) this.commit();
  }

  private commit(): boolean {
    let written = Boolean(this.storage);
    if (this.storage) {
      try {
        if (this.entries.size === 0) {
          this.storage.removeItem(STORAGE_KEY);
        } else {
          this.storage.setItem(STORAGE_KEY, JSON.stringify([...this.entries.values()]));
        }
      } catch {
        // 普通命令保持原有内存降级；首发目录交接由 record 检查写入结果。
        written = false;
      }
    }
    for (const listener of this.listeners) listener();
    return written;
  }

  private notifyResolution(commandId: string, resolution: PendingCommandResolution): void {
    const listeners = this.resolutionListeners.get(commandId);
    if (!listeners) return;
    this.resolutionListeners.delete(commandId);
    for (const listener of listeners) listener(resolution);
  }
}

export const pendingCommandRegistry = new PendingCommandRegistry();
