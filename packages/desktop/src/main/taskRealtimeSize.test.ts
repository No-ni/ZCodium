import { EventEmitter } from "node:events";
import type { UtilityProcess } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HostResponseTypes,
  type TaskRealtimeDeliveredEvent,
  type TaskStreamMirrorBatchEvent,
  type TaskStreamMirrorPublishOp,
} from "@zcode/shared";
import { TaskRealtimeBus } from "./taskRealtimeBus.js";
import { originalReplay, originalSplit } from "./taskRealtimeSize.reference.js";

vi.mock("./logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const target = {
  workspaceKey: "synthetic-identity",
  workspaceIdentity: "synthetic-identity",
  workspacePath: "C:/synthetic",
  taskId: "task",
  runId: "run",
  traceId: "run",
};
const userOp = (content: string, id = "message"): TaskStreamMirrorPublishOp => ({
  kind: "user_message",
  messageId: id,
  content,
  timestamp: 1,
});
function asBatch(delivered: TaskRealtimeDeliveredEvent): TaskStreamMirrorBatchEvent {
  const { originHostId: _origin, deliveryPurpose: _purpose, ...event } = delivered;
  return event as TaskStreamMirrorBatchEvent;
}

function fixture() {
  const warnings = vi.fn();
  const bus = new TaskRealtimeBus({ logger: { info: vi.fn(), warn: warnings } });
  function host(
    id: string,
    workspaceKeys = [target.workspaceKey],
    deliveryKind: "desktop_window" | "relay_bridge" = "desktop_window",
  ) {
    const child = Object.assign(new EventEmitter(), {
      postMessage: vi.fn(),
    });
    bus.registerHost({
      hostId: id,
      windowId: 1,
      child: child as unknown as UtilityProcess,
      workspaceKeys,
      deliveryKind,
    });
    return {
      child,
      send: (message: unknown) => child.emit("message", message),
      events: () =>
        child.postMessage.mock.calls
          .map(([message]) => message.event as TaskRealtimeDeliveredEvent)
          .filter(Boolean),
    };
  }
  const owner = host("owner");
  owner.send({
    type: HostResponseTypes.TaskRunLeaseAcquire,
    request: { ...target, leaseRequestId: "lease" },
  });
  expect(owner.child.postMessage.mock.calls.at(-1)?.[0].result.acquired).toBe(true);
  const publish = (content: string) => {
    owner.send({ type: HostResponseTypes.TaskStreamOpPublish, target, op: userOp(content) });
    vi.advanceTimersByTime(1000);
  };
  return { bus, owner, host, publish, warnings };
}

function countSerializationWork(run: () => void) {
  const stringify = JSON.stringify;
  let ops = 0;
  let calls = 0;
  const spy = vi.spyOn(JSON, "stringify").mockImplementation((value, replacer, space) => {
    calls++;
    if (value && typeof value === "object") {
      if (Array.isArray(value.ops)) ops += value.ops.length;
      else if (value.kind === "user_message" || value.kind === "stream_event") ops++;
    }
    return stringify(value, replacer as never, space);
  });
  try {
    run();
  } finally {
    spy.mockRestore();
  }
  return { ops, calls };
}

describe("realtime replay external behavior", () => {
  it.each(["desktop_window", "relay_bridge"] as const)(
    "replays or emits original gap for %s",
    (kind) => {
      const f = fixture();
      const events: TaskStreamMirrorBatchEvent[] = [];
      for (let index = 0; index < 75; index++) {
        f.publish(index < 61 ? `内容😀\\"${index}` : "x".repeat(90_000));
        events.push(asBatch(f.owner.events().at(-1)!));
        const expected = originalReplay(events);
        const observer = f.host(`observer-${index}`, [target.workspaceKey], kind);
        const delivered = observer.events();
        if (expected[0]?.fromSeq === 1) {
          expect(delivered).toEqual(
            expected.map((event) => ({
              ...event,
              originHostId: "owner",
              deliveryPurpose: "observer",
            })),
          );
        } else {
          expect(delivered).toHaveLength(1);
          expect(delivered[0]).toMatchObject({
            type: "task_snapshot_invalidated",
            reason: "stream_mirror_gap",
            streamWatermark: { runId: "run", opSeq: index + 1 },
          });
        }
        f.bus.unregisterHost(`observer-${index}`);
      }
      expect(f.warnings).not.toHaveBeenCalled();
    },
  );

  it("preserves exact size boundary including UTF-16 and escaping", () => {
    for (const delta of [-1, 0, 1]) {
      const f = fixture();
      f.publish("");
      const first = asBatch(f.owner.events()[0]!);
      const second = {
        ...first,
        eventId: "stream-synthetic-identity-task-run-2",
        createdAt: 3000,
        batchSeq: 2,
        fromSeq: 2,
        toSeq: 2,
        ops: [{ ...userOp(""), seq: 2 }],
      };
      const available = 512 * 1024 - JSON.stringify(first).length - JSON.stringify(second).length;
      f.publish(
        "😀".repeat(Math.floor((available + delta) / 2)) + "x".repeat((available + delta) % 2),
      );
      const actualEvents = f.owner.events().map(asBatch);
      expect(actualEvents.reduce((total, event) => total + JSON.stringify(event).length, 0)).toBe(
        512 * 1024 + delta,
      );
      const expected = originalReplay(actualEvents);
      const observer = f.host("boundary");
      expect(observer.events()[0]?.type).toBe(
        expected[0]?.fromSeq === 1 ? "task_stream_mirror_batch" : "task_snapshot_invalidated",
      );
      f.bus.unregisterHost("owner");
      f.bus.unregisterHost("boundary");
    }
  });

  it("rejects stale owner/run and isolates workspace scopes", () => {
    const f = fixture();
    const outsider = f.host("outsider", ["other-identity"]);
    outsider.send({
      type: HostResponseTypes.TaskStreamOpPublish,
      target,
      op: userOp("wrong-owner"),
    });
    f.owner.send({
      type: HostResponseTypes.TaskStreamOpPublish,
      target: { ...target, runId: "stale", traceId: "stale" },
      op: userOp("stale"),
    });
    f.publish("accepted");
    expect(f.owner.events()).toHaveLength(1);
    expect(outsider.events()).toEqual([]);
    const observer = f.host("observer");
    expect(observer.events()).toHaveLength(1);
    f.bus.updateHostWorkspaceKeys("observer", []);
    f.bus.updateHostWorkspaceKeys("observer", [target.workspaceKey]);
    expect(observer.events()).toHaveLength(1);
    f.bus.unregisterHost("owner");
    expect(observer.events().at(-1)).toMatchObject({ reason: "stream_mirror_owner_lost" });
    expect(f.owner.child.listenerCount("message")).toBe(0);
  });

  it("does one event serialization per flush, independent of retained history", () => {
    const f = fixture();
    const work = countSerializationWork(() => {
      for (let index = 0; index < 120; index++) f.publish("x".repeat(1000));
    });
    expect(f.owner.events()).toHaveLength(120);
    expect(work.ops).toBe(120);
    const events = f.owner.events().map(asBatch);
    const original = countSerializationWork(() => {
      for (const event of events) JSON.stringify(event);
      originalReplay(events);
    });
    expect(original.ops).toBe(5550);
    process.stdout.write(`replay serialization op visits: ${original.ops} -> ${work.ops}\n`);
  });

  it.each(["task_complete", "task_error"] as const)(
    "flushes %s immediately and releases the run",
    (type) => {
      const f = fixture();
      f.owner.send({ type: HostResponseTypes.TaskStreamOpPublish, target, op: userOp("pending") });
      expect(vi.getTimerCount()).toBe(1);
      f.owner.send({
        type: HostResponseTypes.TaskStreamOpPublish,
        target,
        op: {
          kind: "stream_event",
          event: {
            type,
            taskId: "task",
            traceId: "run",
            ...(type === "task_complete" ? { stopReason: "end_turn" } : { error: "synthetic" }),
          },
        },
      });
      expect(f.owner.events()).toHaveLength(1);
      expect(f.owner.events()[0]).toMatchObject({ terminal: true, fromSeq: 1, toSeq: 2 });
      expect(f.bus.collectMemoryDiagnostics()).toMatchObject({ streamBatches: 0, leases: 0 });
      expect(f.host("late").events()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
      expect(f.warnings).not.toHaveBeenCalled();
    },
  );
});

function splitFixture(count: number, content: string, firstSeq = 1): TaskStreamMirrorBatchEvent {
  return {
    ...target,
    type: "task_stream_mirror_batch",
    eventId: "original",
    createdAt: 1,
    batchSeq: 1,
    fromSeq: firstSeq,
    toSeq: firstSeq + count - 1,
    terminal: false,
    ops: Array.from({ length: count }, (_, index) => ({
      ...userOp(content, String(index)),
      seq: firstSeq + index,
    })),
  };
}
function split(bus: TaskRealtimeBus, event: TaskStreamMirrorBatchEvent, nextBatchSeq: number) {
  const batch = { ...target, nextBatchSeq };
  const internal = bus as unknown as {
    splitOversizedBatchForOwner: (
      batch: typeof target & { nextBatchSeq: number },
      event: TaskStreamMirrorBatchEvent,
    ) => TaskStreamMirrorBatchEvent[];
  };
  const chunks = internal.splitOversizedBatchForOwner(batch, event);
  return { chunks, nextBatchSeq: batch.nextBatchSeq };
}

describe("oversized owner batches", () => {
  it("matches original complete chunks across escapes, seq digit changes and single oversized ops", () => {
    const f = fixture();
    for (const content of ["", '😀\ud800\n"\\'.repeat(130), "x".repeat(524_288)]) {
      for (const count of [1, 2, 11, 99]) {
        const event = splitFixture(count, content, 999);
        expect(split(f.bus, event, 9)).toEqual(originalSplit(event, 9));
      }
    }
    // terminal 的 JSON 长度比 false 少一字符，不能忽略该边界。
    const terminal = splitFixture(80, "x".repeat(9000));
    terminal.ops.push({
      kind: "stream_event",
      seq: 81,
      event: { type: "task_complete", taskId: "task", traceId: "run", stopReason: "end_turn" },
    });
    terminal.toSeq = 81;
    terminal.terminal = true;
    expect(split(f.bus, terminal, 99)).toEqual(originalSplit(terminal, 99));
  });

  it("preserves oversized fallback, subsequent gap watermark and ordinary live delivery", () => {
    const f = fixture();
    const observer = f.host("observer", [target.workspaceKey], "relay_bridge");
    f.publish("x".repeat(530_000));
    expect(f.owner.events()[0]).toMatchObject({
      type: "task_stream_mirror_batch",
      batchSeq: 2,
      fromSeq: 1,
      toSeq: 1,
    });
    expect(observer.events()[0]).toMatchObject({
      reason: "stream_mirror_gap",
      streamWatermark: { opSeq: 1 },
    });
    f.publish("after fallback");
    expect(observer.events().at(-1)).toMatchObject({
      type: "task_stream_mirror_batch",
      batchSeq: 3,
      toSeq: 2,
    });
    expect(f.host("late").events()[0]).toMatchObject({
      reason: "stream_mirror_gap",
      streamWatermark: { opSeq: 2 },
    });
  });

  it("serializes each op once instead of each growing prefix", () => {
    const f = fixture();
    const event = splitFixture(1200, "x".repeat(500));
    let result: ReturnType<typeof split> | undefined;
    const work = countSerializationWork(() => {
      result = split(f.bus, event, 2);
    });
    expect(result).toEqual(originalSplit(event, 2));
    expect(work.ops).toBe(event.ops.length);
    const original = countSerializationWork(() => {
      originalSplit(event, 2);
    });
    expect(original.ops).toBe(454_529);
    process.stdout.write(`split serialization op visits: ${original.ops} -> ${work.ops}\n`);
  });

  it("keeps schema-validated oversized terminal chunks identical to the original split", () => {
    const f = fixture();
    const observer = f.host("observer");
    for (let index = 0; index < 1200; index++) {
      f.owner.send({
        type: HostResponseTypes.TaskStreamOpPublish,
        target,
        op: userOp("x".repeat(500), String(index)),
      });
    }
    f.owner.send({
      type: HostResponseTypes.TaskStreamOpPublish,
      target,
      op: {
        kind: "stream_event",
        event: { type: "task_complete", taskId: "task", traceId: "run", stopReason: "end_turn" },
      },
    });
    const chunks = f.owner.events().map(asBatch);
    const event: TaskStreamMirrorBatchEvent = {
      ...chunks[0]!,
      eventId: "stream-synthetic-identity-task-run-1",
      batchSeq: 1,
      fromSeq: 1,
      toSeq: 1201,
      terminal: true,
      ops: chunks.flatMap((chunk) => chunk.ops),
    };
    expect(chunks).toEqual(originalSplit(event, 2).chunks);
    expect(chunks.at(-1)?.terminal).toBe(true);
    expect(chunks.slice(0, -1).every((chunk) => !chunk.terminal)).toBe(true);
    expect(observer.events()).toHaveLength(1);
    expect(observer.events()[0]).toMatchObject({
      reason: "stream_mirror_gap",
      streamWatermark: { opSeq: 1201 },
    });
    expect(f.bus.collectMemoryDiagnostics()).toMatchObject({ streamBatches: 0, leases: 0 });
    expect(vi.getTimerCount()).toBe(0);
    expect(f.warnings).not.toHaveBeenCalled();
  });
});
