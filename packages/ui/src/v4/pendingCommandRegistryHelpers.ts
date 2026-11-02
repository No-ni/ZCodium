import type { CommandAck, ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import type { PendingCommandReplay } from "@/v4/pendingCommandReplay.js";
import { resolvePendingCommandWorkspaceKey } from "@/v4/pendingCommandWorkspace.js";
import type { PendingCommandClientContext } from "@/v4/pendingCommandWorkspace.js";
import type {
  PendingCommandEntry,
  PendingCommandReplayRequest,
  StorageLike,
} from "@/v4/pendingCommandRegistryTypes.js";

export const PENDING_COMMAND_TTL_MS = 24 * 60 * 60 * 1_000;
export const STORAGE_KEY = "zcode-v4-pending-commands:v1";

export function browserStorage(): StorageLike | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function keyOf(sessionId: string | null, commandId: string): string {
  return `${sessionId ?? "<global>"}\u0000${commandId}`;
}

export function clonePayload(payload: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
}

export function isEntry(value: unknown): value is PendingCommandEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<PendingCommandEntry>;
  return (
    typeof entry.commandId === "string" &&
    typeof entry.clientId === "string" &&
    (typeof entry.sessionId === "string" || entry.sessionId === null) &&
    typeof entry.issuedAt === "number" &&
    typeof entry.expiresAt === "number" &&
    Boolean(entry.replay) &&
    typeof entry.replay === "object"
  );
}

export function isRuntimeLocalDiscard(ack: CommandAck): boolean {
  return (
    ack.reasonCode === "fault.command.inputDiscardedOnRestart" &&
    ack.result?.type === "inputDisposition" &&
    (ack.result.delivery === "queue" || ack.result.delivery === "guide")
  );
}

export function findSnapshotSettlements(
  entries: Iterable<PendingCommandEntry>,
  snapshot: ConversationSnapshot,
  workspaceKey?: string,
): { candidates: Map<string, PendingCommandEntry>; settled: Set<string> } | null {
  const candidates = new Map<string, PendingCommandEntry>();
  for (const entry of entries) {
    const key = resolvePendingCommandWorkspaceKey(entry);
    if (workspaceKey !== undefined && key !== null && key !== workspaceKey) continue;
    const scopedCreate =
      workspaceKey !== undefined &&
      key === workspaceKey &&
      entry.sessionId === null &&
      entry.replay.kind === "input" &&
      entry.replay.type === "createSession";
    if (entry.sessionId === snapshot.sessionId || scopedCreate)
      candidates.set(entry.commandId, entry);
  }
  const pending = new Set(candidates.keys());
  if (pending.size === 0) return null;
  const settled = new Set<string>();
  for (const item of snapshot.queue.items) {
    if (item.sourceCommandId && pending.has(item.sourceCommandId)) {
      // 把“进入 queue”当成仍未投递的话，直到 transcript 才清理
      // localStorage；App/CLI 重启后旧 runtime queue 被正常丢弃，却又触发重发提示。
      // queue projection 已是 CLI 权威接收证据，renderer ingress 账本应在此结算。
      settled.add(item.sourceCommandId);
    }
    if (settled.size === pending.size) break;
  }
  // 队列或前面的锚点已覆盖全部待查命令时，后续正文无法提供新的收口证据。
  if (settled.size < pending.size) {
    for (const row of snapshot.rows.window) {
      if (row.kind === "userInput" && row.sourceCommandId && pending.has(row.sourceCommandId)) {
        settled.add(row.sourceCommandId);
      }
      if (
        row.kind === "timelineMarker" &&
        row.marker.type === "compact" &&
        row.sourceCommandId &&
        pending.has(row.sourceCommandId)
      ) {
        // compact 不产生 user row；timeline marker 是该维护命令已开始执行的权威证据。
        settled.add(row.sourceCommandId);
      }
      if (settled.size === pending.size) break;
    }
  }
  if (settled.size === 0) return null;
  return { candidates, settled };
}

export function buildPendingReplayRequest(
  replay: Extract<PendingCommandReplay, { kind: "input" }>,
  sessionId: string | null,
  clientContext?: PendingCommandClientContext,
): PendingCommandReplayRequest {
  const request: PendingCommandReplayRequest = {
    type: replay.type,
    payload: clonePayload(replay.payload),
    sessionId: sessionId,
    ...(replay.baseRevision !== undefined ? { baseRevision: replay.baseRevision } : {}),
    ...(clientContext ? { clientContext: clientContext } : {}),
  };
  // Bug 原因：首发 admission 已持久化旧会话，确认重发沿用旧 ID 会被 CLI 拒绝。
  // 只在用户确认生成新命令时去掉 ID；同命令重试仍保留原信封，也兼容旧恢复记录。
  if (request.type === "createSession") delete request.payload.sessionId;
  return request;
}

// 每个流式帧只扫描原 entries，不复制数组，也不持有第二份账本。
export function hasPendingEntriesForSession(
  entries: Iterable<PendingCommandEntry>,
  sessionId: string,
): boolean {
  for (const entry of entries) {
    if (entry.sessionId === sessionId) return true;
  }
  return false;
}
