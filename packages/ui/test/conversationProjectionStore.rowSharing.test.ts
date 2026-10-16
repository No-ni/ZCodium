import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ConversationDelta,
  ConversationRow,
  ConversationSnapshot,
  ConversationTopicFrame,
  TopicFrameDeliveryKind,
  ToolCallRow,
  V4ConversationRowsRangeResult,
} from "@zcode/shared/zcode-protocol-v4";
import { ConversationRowPool } from "@/v4/conversationRowSharing.js";
import { SessionDataLayer } from "@/v4/sessionDataLayer.js";
import type { ConversationTransport } from "@/v4/transport.js";

vi.mock("@/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    lifecycle: { info: vi.fn(), warn: vi.fn() },
  },
  logMemoryDiagnostics: vi.fn(),
}));

function fresh<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function tool(rowId: number, status: ToolCallRow["status"] = "running"): ToolCallRow {
  const input = { content: "large input ".repeat(2000) };
  return {
    rowId,
    turnId: "t1",
    createdAt: 1,
    createdAtSeq: rowId,
    kind: "toolCall",
    toolCallId: `call-${rowId}`,
    toolName: "Write",
    status,
    input,
    inputText: JSON.stringify(input),
  };
}

function query(rowId: number): ConversationRow {
  return {
    rowId,
    turnId: `t${rowId}`,
    createdAt: 1,
    createdAtSeq: rowId,
    kind: "userInput",
    origin: "realUser",
    text: `question ${rowId}`,
  };
}

function snapshot(
  rows: ConversationRow[],
  overrides: Partial<ConversationSnapshot> = {},
): ConversationSnapshot {
  return {
    protocolVersion: 1,
    sessionId: "s1",
    logEpoch: "epoch-1",
    seq: 5,
    revision: 0,
    control: {
      phase: "draft",
      sessionEnded: false,
      canStop: false,
      stopState: "idle",
      stopTargetKind: "unknown",
      activeWorks: [],
      lastError: null,
      apiRetry: null,
    },
    availability: {
      fork: { allowed: true },
      compact: { allowed: false, reasonCode: "idleCannotCompact" },
      switchModelConfig: { allowed: true },
      setFollowupMode: { allowed: true },
      queueEdit: { allowed: true },
      sendQueuedNow: { allowed: false, reasonCode: "sendQueuedNowRequiresRunning" },
      pauseGoal: { allowed: false, reasonCode: "noGoalToPause" },
      resumeGoal: { allowed: false, reasonCode: "noGoalToResume" },
    },
    inputRouting: { mode: "startNow" },
    config: { provider: "", model: "", thought: "", followupMode: "queue" },
    modelTransition: null,
    usage: {
      contextWindow: null,
      cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    queue: { items: [], autoDrain: true },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    goal: null,
    plan: null,
    rows: { window: rows, totalCount: rows.length, firstRowId: rows[0]?.rowId ?? null },
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const layers: SessionDataLayer[] = [];

function fixture() {
  const listeners = new Set<Parameters<ConversationTransport["onFrame"]>[0]>();
  let subId = 0;
  const transport = {
    subscribe: vi.fn(async () => ({
      ack: { subscriptionId: `sub-${++subId}`, mode: "snapshot" as const, logEpoch: "epoch-1" },
    })),
    activate: vi.fn(),
    unsubscribe: vi.fn(async () => {}),
    resync: vi.fn(async (params) => ({
      ack: {
        subscriptionId: params.subscriptionId,
        mode: params.forceSnapshot ? ("snapshot" as const) : ("resume" as const),
        logEpoch: "epoch-1",
      },
    })),
    rowsRange: vi.fn(async () => range([])),
    onFrame: (listener: Parameters<ConversationTransport["onFrame"]>[0]) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onAssemblyFault: () => () => {},
    onRuntimeRestart: () => () => {},
  } satisfies Partial<ConversationTransport>;
  const layer = new SessionDataLayer({
    transport: transport as ConversationTransport,
    keepWarmMs: 10,
  });
  layers.push(layer);
  return {
    layer,
    transport,
    async open(sessionId = "s1") {
      const lease = layer.acquire(sessionId);
      await Promise.resolve();
      expect(lease.store.getState().subscriptionId).not.toBeNull();
      return lease;
    },
    emit(
      store: ReturnType<SessionDataLayer["acquire"]>["store"],
      payload: ConversationTopicFrame["payload"],
      deliveryKind: TopicFrameDeliveryKind = "online",
      fromSeq = store.getState().snapshot?.seq ?? 0,
      toSeq = payload.kind === "snapshot" ? payload.snapshot.seq : fromSeq + 1,
      subscriptionId = store.getState().subscriptionId!,
    ) {
      const frame = { topic: store.topic, subscriptionId, fromSeq, toSeq, sentAt: 1, payload };
      for (const listener of listeners) listener(frame, { deliveryKind });
    },
  };
}

function range(rows: ConversationRow[], atLogEpoch = "epoch-1"): V4ConversationRowsRangeResult {
  return { rows, atSeq: 5, atRevision: 0, atLogEpoch, hasMore: false };
}

describe("conversation row sharing in the host data layer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(async () => {
    for (const layer of layers.splice(0)) layer.dispose();
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("initial/online/recovery snapshots replace facts but reuse equal rows and windows", async () => {
    const f = fixture();
    const { store } = await f.open();
    f.emit(store, { kind: "snapshot", snapshot: snapshot([tool(1)]) }, "initial");
    const first = store.getState().snapshot!;
    for (const delivery of ["online", "recovery"] as const) {
      const next = snapshot(fresh(first.rows.window), { seq: 6, revision: 2 });
      f.emit(store, { kind: "snapshot", snapshot: next }, delivery);
      expect(store.getState().snapshot).not.toBe(first);
      expect(store.getState().snapshot!.rows.window).toBe(first.rows.window);
      expect(store.getState().snapshot!.seq).toBe(6);
      expect(store.getState().snapshot!.revision).toBe(2);
      expect(store.getState().snapshot!.control).toBe(next.control);
    }
  });

  it("upsert shares unchanged input; append and rewind keep the final authoritative values", async () => {
    const f = fixture();
    const { store } = await f.open();
    f.emit(store, { kind: "snapshot", snapshot: snapshot([tool(1)]) }, "initial");
    const original = store.getState().snapshot!.rows.window[0] as ToolCallRow;
    const done = fresh(tool(1, "success"));
    f.emit(store, { kind: "deltas", deltas: [{ op: "row.upserted", row: done }] });
    const completed = store.getState().snapshot!.rows.window[0] as ToolCallRow;
    expect(completed).not.toBe(original);
    expect(completed.input).toBe(original.input);
    expect(completed.status).toBe("success");
    f.emit(store, { kind: "deltas", deltas: [{ op: "row.appended", row: tool(2) }] });
    const retired = store.getState().snapshot!.rows.window[1]!;
    const replacement = { ...tool(2), toolCallId: "replacement", input: { content: "new branch" } };
    f.emit(store, {
      kind: "deltas",
      deltas: [
        { op: "row.removed", fromRowId: 2 },
        { op: "row.appended", row: replacement },
      ],
    });
    expect(store.getState().snapshot!.rows.window[1]).toEqual(replacement);
    expect(store.getState().snapshot!.rows.window[1]).not.toBe(retired);
    expect(store.getState().snapshot!.rows.window[0]).toBe(completed);
    expect(store.getState().snapshot!.rows.totalCount).toBe(2);
  });

  it("stream deltas only remember the applied row, which an equal later snapshot reuses", async () => {
    const f = fixture();
    const { store } = await f.open();
    f.emit(store, { kind: "snapshot", snapshot: snapshot([tool(1)]) }, "initial");
    const share = vi.spyOn(ConversationRowPool.prototype, "shareRow");
    const remember = vi.spyOn(ConversationRowPool.prototype, "remember");
    f.emit(store, {
      kind: "deltas",
      deltas: [{ op: "row.delta", rowId: 1, path: "inputText", append: " streamed" }],
    });
    const streamed = store.getState().snapshot!.rows.window[0]!;
    expect(share).not.toHaveBeenCalled();
    expect(remember).toHaveBeenCalledWith(store.topic, streamed);
    f.emit(store, { kind: "snapshot", snapshot: snapshot([fresh(streamed)], { seq: 6 }) });
    expect(store.getState().snapshot!.rows.window[0]).toBe(streamed);
  });

  it("a mixed frame shares the final upsert/stream result once and leaves other rows alone", async () => {
    const f = fixture();
    const { store } = await f.open();
    f.emit(store, { kind: "snapshot", snapshot: snapshot([tool(1), tool(2)]) }, "initial");
    const [first, untouched] = store.getState().snapshot!.rows.window as ToolCallRow[];
    const share = vi.spyOn(ConversationRowPool.prototype, "shareRow");
    f.emit(store, {
      kind: "deltas",
      deltas: [
        { op: "row.upserted", row: fresh(tool(1, "success")) },
        { op: "row.delta", rowId: 1, path: "inputText", append: " final" },
        { op: "row.delta", rowId: 99, path: "inputText", append: "not loaded" },
      ],
    });
    const [updated, same] = store.getState().snapshot!.rows.window as ToolCallRow[];
    expect(share).toHaveBeenCalledTimes(1);
    expect(updated!.input).toBe(first!.input);
    expect(updated!.inputText).toBe(`${first!.inputText} final`);
    expect(updated!.status).toBe("success");
    expect(same).toBe(untouched);
    expect(store.getState().snapshot!.rows.totalCount).toBe(2);
  });

  it("keep-warm reacquire keeps the store and cancels its pending close", async () => {
    const f = fixture();
    const lease = await f.open();
    f.emit(lease.store, { kind: "snapshot", snapshot: snapshot([tool(1)]) }, "initial");
    const original = lease.store.getState().snapshot;
    const secondPane = await f.open();
    expect(secondPane.openKind).toBe("warm");
    lease.release();
    lease.release();
    await vi.advanceTimersByTimeAsync(10);
    expect(lease.store.getState().status).toBe("live");
    secondPane.release();
    expect(vi.getTimerCount()).toBe(1);
    const reopened = await f.open();
    expect(reopened.openKind).toBe("keep_warm");
    expect(reopened.store).toBe(lease.store);
    expect(reopened.store.getState().snapshot).toBe(original);
    await vi.advanceTimersByTimeAsync(10);
    expect(f.transport.unsubscribe).not.toHaveBeenCalled();
    expect(f.transport.subscribe).toHaveBeenCalledTimes(1);
  });

  it("cold reopening reuses surviving rows; sessions and host connections stay isolated", async () => {
    const f = fixture();
    const first = await f.open();
    f.emit(first.store, { kind: "snapshot", snapshot: snapshot([tool(1)]) }, "initial");
    const original = first.store.getState().snapshot!.rows.window[0]!;
    first.release();
    await vi.advanceTimersByTimeAsync(10);
    expect(first.store.getState().status).toBe("closed");
    expect(f.transport.unsubscribe).toHaveBeenCalledWith("sub-1");
    const reopened = await f.open();
    expect(reopened.openKind).toBe("cold");
    expect(reopened.store).not.toBe(first.store);
    f.emit(reopened.store, { kind: "snapshot", snapshot: snapshot([fresh(original)]) }, "initial");
    expect(reopened.store.getState().snapshot!.rows.window[0]).toBe(original);
    const otherSession = await f.open("s2");
    f.emit(
      otherSession.store,
      {
        kind: "snapshot",
        snapshot: snapshot([fresh(original)], { sessionId: "s2" }),
      },
      "initial",
    );
    expect(otherSession.store.getState().snapshot!.rows.window[0]).not.toBe(original);
    const otherHost = fixture();
    const other = await otherHost.open();
    otherHost.emit(
      other.store,
      { kind: "snapshot", snapshot: snapshot([fresh(original)]) },
      "initial",
    );
    expect(other.store.getState().snapshot!.rows.window[0]).not.toBe(original);
  });

  it.each(["loadOlder", "loadAllOlder"] as const)(
    "%s shares accepted history only",
    async (method) => {
      const f = fixture();
      const { store } = await f.open();
      const history = [query(1), tool(2)];
      const tail = [query(3)];
      f.emit(store, { kind: "snapshot", snapshot: snapshot([...history, ...tail]) }, "initial");
      const original = store.getState().snapshot!.rows.window[1]!;
      f.emit(store, {
        kind: "snapshot",
        snapshot: snapshot(fresh(tail), {
          rows: { window: fresh(tail), totalCount: 3, firstRowId: 1 },
        }),
      });
      f.transport.rowsRange.mockResolvedValue(range(fresh(history)));
      await store[method]();
      expect(store.getState().snapshot!.rows.window.map((row) => row.rowId)).toEqual([1, 2, 3]);
      expect(store.getState().snapshot!.rows.window[1]).toBe(original);
    },
  );

  it("full-history hydration preserves a partial leading turn even with fewer than two queries", async () => {
    const f = fixture();
    const { store } = await f.open();
    const history = [query(1), tool(2)];
    const tail = [tool(3)];
    f.emit(store, { kind: "snapshot", snapshot: snapshot([...history, ...tail]) }, "initial");
    const original = store.getState().snapshot!.rows.window[1]!;
    f.emit(store, {
      kind: "snapshot",
      snapshot: snapshot(fresh(tail), {
        rows: { window: fresh(tail), totalCount: 3, firstRowId: 1 },
      }),
    });
    f.transport.rowsRange.mockResolvedValue(range(fresh(history)));
    const result = await store.loadAllOlder();
    expect(result.status).toBe("not-enough-queries");
    expect(store.getState().snapshot!.rows.window.map((row) => row.rowId)).toEqual([1, 2, 3]);
    expect(store.getState().snapshot!.rows.window[1]).toBe(original);
  });

  it.each(["loadOlder", "loadAllOlder"] as const)(
    "%s rejects stale epoch and cursor before touching the pool",
    async (method) => {
      for (const invalidation of ["epoch", "cursor"] as const) {
        const f = fixture();
        const { store } = await f.open();
        const tail = [tool(3)];
        f.emit(
          store,
          {
            kind: "snapshot",
            snapshot: snapshot(tail, { rows: { window: tail, totalCount: 3, firstRowId: 1 } }),
          },
          "initial",
        );
        const pending = deferred<V4ConversationRowsRangeResult>();
        f.transport.rowsRange.mockReturnValue(pending.promise);
        const flight = store[method]();
        if (invalidation === "cursor") {
          f.emit(store, { kind: "snapshot", snapshot: snapshot([tool(4)], { seq: 6 }) });
        }
        const before = store.getState().snapshot;
        const share = vi.spyOn(ConversationRowPool.prototype, "shareRow");
        pending.resolve(range([tool(2)], invalidation === "epoch" ? "retired-epoch" : "epoch-1"));
        await flight;
        expect(share).not.toHaveBeenCalled();
        expect(store.getState().snapshot).toBe(before);
        share.mockRestore();
      }
    },
  );

  it("old subscriptions, duplicate deltas and gaps do not mutate the pool or applied base", async () => {
    const f = fixture();
    const { store } = await f.open();
    f.emit(store, { kind: "snapshot", snapshot: snapshot([tool(1)]) }, "initial");
    const before = store.getState().snapshot;
    const share = vi.spyOn(ConversationRowPool.prototype, "shareRow");
    const deltas: ConversationDelta[] = [{ op: "row.upserted", row: tool(1, "success") }];
    f.emit(store, { kind: "deltas", deltas }, "online", 5, 6, "retired-sub");
    f.emit(store, { kind: "deltas", deltas }, "online", 4, 5);
    f.emit(store, { kind: "deltas", deltas }, "online", 8, 9);
    expect(store.getState().snapshot).toBe(before);
    expect(share).not.toHaveBeenCalled();
    expect(f.transport.resync).toHaveBeenCalledWith({
      subscriptionId: "sub-1",
      base: { logEpoch: "epoch-1", seq: 5 },
    });
    await Promise.resolve();
    f.emit(
      store,
      { kind: "snapshot", snapshot: snapshot(fresh(before!.rows.window), { seq: 9 }) },
      "recovery",
    );
    expect(store.getState().snapshot!.seq).toBe(9);
    expect(store.getState().snapshot!.rows.window).toBe(before!.rows.window);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a snapshot ACK without a delivered base rejects deltas and requests full recovery", async () => {
    const f = fixture();
    const { store } = await f.open();
    const share = vi.spyOn(ConversationRowPool.prototype, "shareRow");
    f.emit(store, { kind: "deltas", deltas: [{ op: "row.appended", row: tool(1) }] });
    expect(store.getState().snapshot).toBeNull();
    expect(share).not.toHaveBeenCalled();
    expect(f.transport.resync).toHaveBeenCalledWith({
      subscriptionId: "sub-1",
      base: null,
      forceSnapshot: true,
    });
    await Promise.resolve();
    f.emit(store, { kind: "snapshot", snapshot: snapshot([tool(1)]) }, "recovery");
    expect(store.getState().snapshot!.rows.window).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
