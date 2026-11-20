import {
  remapPendingCreatedSession,
  prunePendingCommandEntries,
} from "./pendingCommandRegistryHelpers.js";
// V4 已提交命令的 renderer 持久账本。
// 它只保存客户端恢复线索，不参与 conversation projection，也绝不能据此自动重放。
import { permissionGrantMode } from "@zcode/shared/zcode-protocol-v4";
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
import { pendingCommandReplayFor, type PendingCommandReplay } from "@/v4/pendingCommandReplay.js";
import { logger } from "@/logger.js";
import { acceptComposerRecentReceipt, type FullAccessRecentReceipt } from "@/lib/composerRecent.js";
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
  isRuntimeLocalDiscard,
  keyOf,
  loadPendingCommandEntries,
  PENDING_COMMAND_TTL_MS,
  writePendingCommandEntries,
} from "@/v4/pendingCommandRegistryHelpers.js";
import {
  notifyPendingResolution,
  subscribePendingResolution,
  type PendingResolutionState,
} from "@/v4/pendingCommandResolutions.js";
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
  private readonly preparingGrant = new WeakMap<PendingCommandEntry, Promise<void>>();
  private readonly listeners = new Set<() => void>();
  private readonly resolutions: PendingResolutionState;
  private readonly reconcileInFlight = new Map<string, Promise<void>>();
  private queryBatchDepth = 0;
  private queryBatchChanged = false;

  constructor(options: PendingCommandRegistryOptions = {}) {
    this.storage = options.storage ?? browserStorage();
    this.now = options.now ?? Date.now;
    this.resolutions = { listeners: new Map(), completed: new Map(), now: this.now };
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
    return subscribePendingResolution(this.resolutions, commandId, listener);
  }

  record(
    envelope: CommandEnvelope,
    clientContext?: PendingCommandClientContext,
    resolveGrant?: () => Promise<FullAccessRecentReceipt>,
  ): PendingCommandEntry | null {
    this.pruneExpired();
    const replay = pendingCommandReplayFor(envelope);
    if (!replay) return null;
    const key = keyOf(envelope.sessionId, envelope.commandId);
    const existing = this.entries.get(key);
    if (existing) return existing;
    this.resolutions.completed.delete(envelope.commandId);
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
    if (resolveGrant) {
      // 先登记命令，再并行查询归属。慢查询只影响偏好，不推迟工具审批或错误提示。
      const ready = Promise.resolve()
        .then(resolveGrant)
        .then((grant) => {
          if (this.entries.get(key) !== entry) return;
          entry.clientContext = { ...entry.clientContext, fullAccess: grant };
          this.commit();
        })
        .catch((error) => {
          logger.warn("[v4-interaction] 未能确定项目归属，跳过权限偏好记录", {
            commandId: envelope.commandId,
            error,
          });
        })
        .finally(() => this.preparingGrant.delete(entry));
      this.preparingGrant.set(entry, ready);
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
      void this.settleSensitive(entry, ack);
      return;
    }
    entry = this.remapCreatedSession(entry, ack);
    if (ack.status === "accepted" || ack.status === "duplicate") {
      if (!this.acceptComposer(entry)) return;
      this.clearRecovery(entry);
      notifyPendingResolution(this.resolutions, entry.commandId, ack.status);
      return;
    }
    if (ack.status === "failed" && ack.reasonCode === "fault.command.inputDiscardedOnRestart") {
      this.rejectComposer(entry);
      if (isRuntimeLocalDiscard(ack)) {
        notifyPendingResolution(this.resolutions, entry.commandId, "discarded");
        this.settle(entry.sessionId, entry.commandId);
        return;
      }
      notifyPendingResolution(this.resolutions, entry.commandId, "failed");
      this.markRecovery(entry, "discarded");
      return;
    }
    this.rejectComposer(entry);
    notifyPendingResolution(this.resolutions, entry.commandId, "failed");
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
          notifyPendingResolution(this.resolutions, entry.commandId, "discarded");
          this.settle(entry.sessionId, entry.commandId);
          continue;
        }
        notifyPendingResolution(this.resolutions, entry.commandId, "failed");
        this.markRecovery(entry, "discarded");
        continue;
      }
      entry = this.remapCreatedSession(entry, item.result);
      if (entry.replay.kind === "sensitiveDigest") {
        void this.settleSensitive(entry, item.result);
        continue;
      }
      if (item.result.status === "accepted" || item.result.status === "duplicate") {
        if (!this.acceptComposer(entry)) continue;
        this.clearRecovery(entry);
        notifyPendingResolution(this.resolutions, entry.commandId, item.result.status);
      } else {
        this.rejectComposer(entry);
        notifyPendingResolution(this.resolutions, entry.commandId, "failed");
        this.settle(entry.sessionId, entry.commandId);
      }
    }
  }

  reconcileSnapshot(snapshot: ConversationSnapshot, workspaceKey?: string): void {
    // Bug 根因：每个流式帧都会逐行扫描全部历史来收集 sourceCommandId。只有本会话还有待对账条目、
    // 或有人在等某个命令的结算时，扫描才可能产生效果；两者都没有时直接返回，结果不变。
    if (
      this.resolutions.listeners.size === 0 &&
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
      notifyPendingResolution(this.resolutions, commandId, "authoritative");
      changed = this.entries.delete(keyOf(snapshot.sessionId, commandId)) || changed;
    }
    if (changed) this.commit();
  }

  private async settleSensitive(entry: PendingCommandEntry, ack: CommandAck): Promise<void> {
    const resolved = ack.result?.type === "resolveInteraction" ? ack.result.resolvedBy : undefined;
    if (
      (ack.status === "accepted" || ack.status === "duplicate") &&
      resolved?.clientId === entry.clientId
    ) {
      const preparing = this.preparingGrant.get(entry);
      if (preparing) {
        await preparing;
        // ACK 和 query 可同时确认同一命令，清账之后不再回写。
        if (this.entries.get(keyOf(entry.sessionId, entry.commandId)) !== entry) return;
      }
      const grant = entry.clientContext?.fullAccess;
      if (
        grant &&
        permissionGrantMode(resolved.optionId) === grant.mode &&
        !acceptComposerRecentReceipt(grant, this.storage)
      )
        return;
    }
    this.settle(entry.sessionId, entry.commandId);
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
    const remapped = remapPendingCreatedSession(this.entries, entry, ack);
    if (remapped !== entry) this.commit();
    return remapped;
  }

  private load(): void {
    for (const entry of loadPendingCommandEntries(this.storage))
      this.entries.set(keyOf(entry.sessionId, entry.commandId), entry);
    this.pruneExpired();
  }

  private pruneExpired(): void {
    if (
      prunePendingCommandEntries(this.entries, this.now(), (entry) =>
        ownsPendingCommandDraft(entry),
      )
    )
      this.commit();
  }

  private commit(): boolean {
    const written = writePendingCommandEntries(this.storage, this.entries);
    for (const listener of this.listeners) listener();
    return written;
  }
}

export const pendingCommandRegistry = new PendingCommandRegistry();
