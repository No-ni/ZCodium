import type { PendingCommandResolution } from "@/v4/pendingCommandRegistryTypes.js";

type Listener = (resolution: PendingCommandResolution) => void;
export interface PendingResolutionState {
  listeners: Map<string, Set<Listener>>;
  completed: Map<string, { resolution: PendingCommandResolution; expiresAt: number }>;
  now: () => number;
}
const LIMIT = 512;
const TTL_MS = 5 * 60 * 1_000;

function prune(state: PendingResolutionState): void {
  const now = state.now();
  for (const [id, value] of state.completed) {
    if (value.expiresAt <= now) state.completed.delete(id);
  }
}

/** ACK 可先于订阅；仅回放 Registry 已发出的结论，不重建输入或触发 admission。 */
export function subscribePendingResolution(
  state: PendingResolutionState,
  commandId: string,
  listener: Listener,
): () => void {
  prune(state);
  const completed = state.completed.get(commandId);
  if (completed) {
    listener(completed.resolution);
    return () => {};
  }
  const listeners = state.listeners.get(commandId) ?? new Set<Listener>();
  listeners.add(listener);
  state.listeners.set(commandId, listeners);
  return () => {
    const current = state.listeners.get(commandId);
    current?.delete(listener);
    if (current?.size === 0) state.listeners.delete(commandId);
  };
}

export function notifyPendingResolution(
  state: PendingResolutionState,
  commandId: string,
  resolution: PendingCommandResolution,
): void {
  prune(state);
  // Bug 原因：无人订阅时通知曾被丢弃，卸载重挂后的 Composer 永远等不到已经接纳的结论。
  // 只在原 Registry 内保留有界通知；不保存正文，也不改变 CLI 的 accepted 权威。
  state.completed.delete(commandId);
  state.completed.set(commandId, { resolution, expiresAt: state.now() + TTL_MS });
  while (state.completed.size > LIMIT) {
    const oldest = state.completed.keys().next().value;
    if (oldest !== undefined) state.completed.delete(oldest);
  }
  const listeners = state.listeners.get(commandId);
  state.listeners.delete(commandId);
  if (listeners) for (const listener of listeners) listener(resolution);
}
