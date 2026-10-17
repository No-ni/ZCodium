import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Emitter } from "@zcode/rpc";
import type { IWindowControllerService, WindowHostControllerFrame } from "@zcode/services";
import {
  CONTROLLER_TASKS_INDEX_TOPIC as TASKS,
  CONTROLLER_WORKSPACES_TOPIC as WORKSPACES,
  type ControllerResyncResult,
  type WindowHostControllerTaskRow,
} from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";
import { getWindowControllerTaskListRegistry } from "@/v4/windowControllerTaskListRegistry.js";

type Topic = typeof TASKS | typeof WORKSPACES;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function flush() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function snapshot(
  seq: number,
  topic: Topic = TASKS,
  rows: WindowHostControllerTaskRow[] = [],
  epoch = "epoch",
): WindowHostControllerFrame {
  const common = { subscriptionId: topic, logEpoch: epoch, fromSeq: 0, toSeq: seq, sentAt: 0 };
  return topic === TASKS
    ? {
        ...common,
        topic,
        payload: {
          kind: "snapshot",
          snapshot: { protocolVersion: 1, logEpoch: epoch, tasks: rows },
        },
      }
    : {
        ...common,
        topic,
        payload: {
          kind: "snapshot",
          snapshot: { protocolVersion: 1, logEpoch: epoch, workspaces: [] },
        },
      };
}

function delta(fromSeq: number, topic: Topic = TASKS, epoch = "epoch"): WindowHostControllerFrame {
  const common = { subscriptionId: topic, logEpoch: epoch, fromSeq, toSeq: fromSeq + 1, sentAt: 0 };
  return topic === TASKS
    ? { ...common, topic, payload: { kind: "deltas", deltas: [] } }
    : { ...common, topic, payload: { kind: "deltas", deltas: [] } };
}

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
async function fixture() {
  const frames = new Emitter<WindowHostControllerFrame>();
  const flights: Array<ReturnType<typeof deferred<ControllerResyncResult>>> = [];
  const subscribe = vi.fn<IWindowControllerService["subscribeControllerV4"]>(async ({ topic }) => ({
    ack: { subscriptionId: topic, mode: "snapshot", logEpoch: "epoch" },
  }));
  const resync = vi.fn<IWindowControllerService["resyncControllerV4"]>(() => {
    const flight = deferred<ControllerResyncResult>();
    flights.push(flight);
    return flight.promise;
  });
  const unsubscribe = vi.fn<IWindowControllerService["unsubscribeControllerV4"]>(async () => {});
  const list = vi.fn<IWindowControllerService["listTaskList"]>(async () => ({
    items: [],
    total: 0,
    hasMore: false,
  }));
  const controller = {
    onDynamicControllerFrame: () => frames.event,
    subscribeControllerV4: subscribe,
    resyncControllerV4: resync,
    unsubscribeControllerV4: unsubscribe,
    listTaskList: list,
  } as unknown as IWindowControllerService;
  const registry = getWindowControllerTaskListRegistry(controller);
  const notified = vi.fn();
  const stops = [registry.subscribe(notified)];
  frames.fire(snapshot(10));
  frames.fire(snapshot(10, WORKSPACES));
  await flush();
  notified.mockClear();
  const done = (index: number) =>
    flights[index]!.resolve({
      ack: {
        subscriptionId: resync.mock.calls[index]![0].subscriptionId,
        mode: "snapshot",
        logEpoch: "epoch",
      },
    });
  const instance = {
    frames,
    flights,
    controller,
    registry,
    resync,
    subscribe,
    unsubscribe,
    list,
    notified,
    stops,
    done,
  };
  fixtures.push(instance);
  return instance;
}

beforeEach(() => vi.spyOn(logger, "warn").mockImplementation(() => {}));
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    for (const stop of fixture.stops) stop();
    // 先停止 owner 再完成 fake IO，不能让清理路径安排新的补拉。
    fixture.flights.forEach((_, index) => fixture.done(index));
    fixture.frames.dispose();
  }
  await flush();
  vi.restoreAllMocks();
});

describe("controller gap recovery coalescing", () => {
  it("coalesces 64 same-cursor gaps and follows up once for discarded updates", async () => {
    const f = await fixture();
    for (let index = 0; index < 64; index += 1) f.frames.fire(delta(20 + index));
    expect(f.resync.mock.calls.length).toBe(1);
    expect(f.resync.mock.calls[0]![0]).toEqual({
      subscriptionId: TASKS,
      base: { logEpoch: "epoch", seq: 10 },
      forceSnapshot: true,
    });
    expect(f.notified.mock.calls.length).toBe(0);
    f.frames.fire(snapshot(25));
    f.done(0);
    await flush();
    expect(f.resync.mock.calls.length).toBe(2);
    expect(f.resync.mock.calls[1]![0].base).toEqual({ logEpoch: "epoch", seq: 25 });
    f.frames.fire(snapshot(84));
    f.done(1);
    await flush();
    expect(f.resync.mock.calls.length).toBe(2);
    f.frames.fire(delta(84));
    expect(f.resync.mock.calls.length).toBe(2);
  });

  it("does not follow up after a single gap and allows a later gap after ACK", async () => {
    const f = await fixture();
    f.frames.fire(delta(20));
    f.done(0);
    await flush();
    expect(f.resync.mock.calls.length).toBe(1);
    f.frames.fire(delta(21));
    expect(f.resync.mock.calls.length).toBe(2);
    expect(f.resync.mock.calls[1]![0].base?.seq).toBe(10); // ACK 本身不是快照。
  });

  it.each(["ack", "failure"] as const)(
    "new cursor recovers before old %s and old cleanup cannot erase it",
    async (completion) => {
      const f = await fixture();
      f.frames.fire(delta(20));
      f.frames.fire(delta(21)); // 旧调用有待补拉信号。
      f.frames.fire(snapshot(30));
      f.frames.fire(delta(40));
      expect(f.resync.mock.calls.length).toBe(2);
      if (completion === "ack") f.done(0);
      else f.flights[0]!.reject(new Error("old recovery failed"));
      await flush();
      f.frames.fire(delta(41));
      expect(f.resync.mock.calls.length).toBe(2);
      f.frames.fire(snapshot(42));
      f.done(1);
      await flush();
      expect(f.resync.mock.calls.length).toBe(3);
      expect(f.resync.mock.calls[2]![0].base?.seq).toBe(42);
    },
  );

  it("follows up even when ACK arrives before the first snapshot", async () => {
    const f = await fixture();
    f.frames.fire(delta(20));
    f.frames.fire(delta(21));
    f.done(0);
    await flush();
    expect(f.resync.mock.calls.length).toBe(2);
    expect(f.resync.mock.calls[1]![0].base?.seq).toBe(10);
    f.frames.fire(snapshot(21));
    f.frames.fire(snapshot(22));
    f.done(1);
    await flush();
    f.frames.fire(delta(22));
    expect(f.resync.mock.calls.length).toBe(2);
  });

  it("uses coalesced signals for one retry on failure without an autonomous retry loop", async () => {
    const f = await fixture();
    f.frames.fire(delta(20));
    f.frames.fire(delta(21));
    f.flights[0]!.reject(new Error("first failed"));
    await flush();
    expect(f.resync.mock.calls.length).toBe(2);
    f.flights[1]!.reject(new Error("retry failed"));
    await flush();
    expect(f.resync.mock.calls.length).toBe(2);
    expect(vi.mocked(logger.warn).mock.calls.length).toBe(2);
    f.frames.fire(delta(22));
    expect(f.resync.mock.calls.length).toBe(3);
  });

  it("coalesces a second burst during the follow-up without losing its final signal", async () => {
    const f = await fixture();
    f.frames.fire(delta(20));
    f.frames.fire(delta(21));
    f.frames.fire(snapshot(22));
    f.done(0);
    await flush();
    expect(f.resync.mock.calls.length).toBe(2);
    for (let index = 30; index < 62; index += 1) f.frames.fire(delta(index));
    expect(f.resync.mock.calls.length).toBe(2);
    f.frames.fire(snapshot(62));
    f.done(1);
    await flush();
    expect(f.resync.mock.calls.length).toBe(3);
    f.done(2);
    await flush();
    expect(f.resync.mock.calls.length).toBe(3);
  });

  it("recovers task and workspace subscriptions independently", async () => {
    const f = await fixture();
    f.frames.fire(delta(20));
    f.frames.fire(delta(20, WORKSPACES));
    f.frames.fire(delta(21));
    f.frames.fire(delta(21, WORKSPACES));
    expect(f.resync.mock.calls.length).toBe(2);
    expect(f.resync.mock.calls.map(([params]) => params.subscriptionId)).toEqual([
      TASKS,
      WORKSPACES,
    ]);
  });

  it("stops follow-up work with the last consumer and ignores late frames", async () => {
    const f = await fixture();
    f.frames.fire(delta(20));
    f.frames.fire(delta(21));
    f.stops[0]!();
    f.done(0);
    await flush();
    f.frames.fire(delta(30));
    expect(f.resync.mock.calls.length).toBe(1);
    expect(f.unsubscribe.mock.calls.map(([params]) => params.subscriptionId).sort()).toEqual(
      [TASKS, WORKSPACES].sort(),
    );
    expect(f.notified.mock.calls.length).toBe(0);
  });

  it("does not let an old generation failure clear a restarted subscription's flight", async () => {
    const f = await fixture();
    f.frames.fire(delta(20));
    f.frames.fire(delta(21));
    f.stops[0]!();
    f.stops.push(f.registry.subscribe(f.notified));
    f.frames.fire(snapshot(10)); // 刻意复用 subscription ID 和游标数值，代次仍不同。
    f.frames.fire(delta(30));
    f.flights[0]!.reject(new Error("old generation failed"));
    await flush();
    f.frames.fire(delta(31));
    expect(f.resync.mock.calls.length).toBe(2);
    f.done(1);
    await flush();
    expect(f.resync.mock.calls.length).toBe(3);
  });

  it("shares one recovery across consumers but isolates different controller instances", async () => {
    const f = await fixture();
    const other = await fixture();
    expect(getWindowControllerTaskListRegistry(f.controller)).toBe(f.registry);
    f.stops.push(f.registry.subscribe(() => {}));
    expect(f.subscribe.mock.calls.length).toBe(2);
    f.stops[0]!();
    f.frames.fire(delta(20));
    f.frames.fire(delta(21));
    other.frames.fire(delta(20));
    expect(f.resync.mock.calls.length).toBe(1);
    expect(other.resync.mock.calls.length).toBe(1);
  });

  it("accepts a new snapshot epoch before old ACK and uses that epoch for recovery", async () => {
    const f = await fixture();
    f.frames.fire(delta(20));
    f.frames.fire(snapshot(10, TASKS, [], "new-epoch"));
    f.frames.fire(delta(20, TASKS, "new-epoch"));
    f.frames.fire(delta(21, TASKS, "new-epoch"));
    expect(f.resync.mock.calls.length).toBe(2);
    expect(f.resync.mock.calls[1]![0].base).toEqual({ logEpoch: "new-epoch", seq: 10 });
  });

  it("cleans a synchronous service failure so a later gap can recover", async () => {
    const f = await fixture();
    f.resync.mockImplementationOnce(() => {
      throw new Error("synchronous failure");
    });
    expect(() => f.frames.fire(delta(20))).not.toThrow();
    expect(vi.mocked(logger.warn).mock.calls.length).toBe(1);
    f.frames.fire(delta(21));
    f.frames.fire(delta(22));
    expect(f.resync.mock.calls.length).toBe(2);
  });

  it("treats a newly accepted snapshot with equal cursor values as a new recovery boundary", async () => {
    const f = await fixture();
    f.frames.fire(delta(20));
    f.frames.fire(snapshot(10));
    f.frames.fire(delta(21));
    f.frames.fire(delta(22));
    expect(f.resync.mock.calls.length).toBe(2);
    expect(f.resync.mock.calls[1]![0].base).toEqual({ logEpoch: "epoch", seq: 10 });
  });

  it("allows a new gap after a contiguous delta advances the cursor before old ACK", async () => {
    const f = await fixture();
    f.frames.fire(delta(20));
    f.frames.fire(delta(21));
    f.frames.fire(delta(10));
    f.frames.fire(delta(22));
    expect(f.resync.mock.calls.length).toBe(2);
    expect(f.resync.mock.calls[1]![0].base?.seq).toBe(11);
    f.done(0);
    await flush();
    expect(f.resync.mock.calls.length).toBe(2);
  });

  it("keeps caches on gaps and preserves snapshot/delta invalidation and batched revisions", async () => {
    const f = await fixture();
    const workspacePath = "C:/synthetic/workspace";
    const row: WindowHostControllerTaskRow = {
      address: { workspacePath, taskId: "current" },
      meta: {
        taskId: "current",
        workspacePath,
        title: "Current",
        traceId: "synthetic",
        mode: "edit",
        createdAt: 1,
        updatedAt: 2,
      },
      membership: { pinned: true, archived: false, active: true },
      sourceAvailability: "online",
      liveStatus: "idle",
    };
    f.frames.fire(snapshot(10, TASKS, [row]));
    await flush();
    f.notified.mockClear();
    const version = { controllerRevision: 0, taskListVersionSignature: "synthetic" };
    const query = {
      kind: "timeline" as const,
      workspaceScopes: [{ workspacePath }],
      sortBy: "updated" as const,
    };
    const timeline = f.registry.list("timeline", version, query);
    const pinned = f.registry.list("pinned", version, { ...query, kind: "pinned" });
    await Promise.all([timeline, pinned]);
    const revision = f.registry.getRevision();
    f.frames.fire(delta(20));
    f.frames.fire(delta(21));
    await flush();
    expect(f.registry.list("timeline", version, query)).toBe(timeline);
    expect(f.registry.list("pinned", version, { ...query, kind: "pinned" })).toBe(pinned);
    expect(f.registry.getRevision()).toBe(revision);
    expect(f.notified.mock.calls.length).toBe(0);

    f.frames.fire(snapshot(22, TASKS, [row]));
    await flush();
    const refreshedTimeline = f.registry.list("timeline", version, query);
    const refreshedPinned = f.registry.list("pinned", version, { ...query, kind: "pinned" });
    expect(refreshedTimeline).not.toBe(timeline);
    expect(refreshedPinned).not.toBe(pinned);
    await Promise.all([refreshedTimeline, refreshedPinned]);
    f.notified.mockClear();
    const beforeDelta = f.registry.getRevision();
    f.frames.fire({
      ...delta(22),
      topic: TASKS,
      payload: {
        kind: "deltas",
        deltas: [
          { op: "task.upserted", task: { ...row, meta: { ...row.meta, title: "Updated" } } },
        ],
      },
    });
    f.frames.fire(delta(23));
    await flush();
    expect(f.registry.list("timeline", version, query)).toBe(refreshedTimeline);
    expect(f.registry.list("pinned", version, { ...query, kind: "pinned" })).not.toBe(
      refreshedPinned,
    );
    expect(f.registry.getRevision()).toBe(beforeDelta + 1);
    expect(f.notified.mock.calls.length).toBe(1);
  });
});
