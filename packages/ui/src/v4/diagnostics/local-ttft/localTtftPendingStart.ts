// local-ttft 一次发送观测的初始 context 与 pending（spec：docs/monitoring/ttft-stage-telemetry.md）。
// 从 LocalTtftObserver.start 拆出：门禁、expire、emit、capacity 与 pending Map 仍由 Observer 拥有，
// 这里只按传入的 workspace/busy/localOnly/isForeground 与时钟函数构造初始值；
// crypto.randomUUID、now 两次、wallNow 一次的调用顺序逐字不变，时钟以函数传入、不提前求值。
import type { LocalTtftContext } from "@zcode/shared";
import type { LocalTtftPending as Pending } from "@/v4/diagnostics/local-ttft/localTtftRecord.js";

export function createLocalTtftPendingStart({
  workspace,
  busy,
  submittedAt,
  localOnly,
  isForeground,
  readNow,
  readWallNow,
}: {
  workspace: string;
  busy: boolean;
  submittedAt?: number;
  localOnly: boolean;
  isForeground: boolean;
  readNow: () => number;
  readWallNow: () => number;
}): { context: LocalTtftContext; pending: Pending } {
  const context: LocalTtftContext = {
    version: 1,
    observationId: crypto.randomUUID(),
    ...(localOnly ? { localOnly: true as const } : {}),
  };
  const now = readNow();
  const start = submittedAt !== undefined && submittedAt <= now ? submittedAt : now;
  const pending: Pending = {
    context,
    workspace,
    start,
    wallStart: readWallNow() - (now - start),
    checkpointRevision: 0,
    lastSeq: -1,
    rows: new Map(),
    sendMode: busy ? "queued" : "idle",
    visibility: isForeground ? "foreground" : "background",
    visibilityChanges: [{ at: readNow(), foreground: isForeground }],
    confirmations: [],
  };
  return { context, pending };
}
