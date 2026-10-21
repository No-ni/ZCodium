import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import * as shared from "@zcode/shared";
import { createTaskRealtimeBridgeForHostInit } from "../../desktop/src/host/taskRealtimeBridge.js";
import type { SessionRealtimePort } from "../../services/src/session/sessionRealtimePort.js";
import {
  linearRandom,
  loadLinearBaseline,
  measureLinearHotpath,
} from "./performanceLinearBaseline.js";

const original = (
  await loadLinearBaseline<{
    createTaskRealtimeBridgeForHostInit: typeof createTaskRealtimeBridgeForHostInit;
  }>("task-realtime-bridge.ts.txt", { "@zcode/shared": shared })
).createTaskRealtimeBridgeForHostInit;

const target = {
  workspacePath: "C:/synthetic",
  workspaceIdentity: "synthetic-identity",
  workspaceKey: "synthetic-identity",
  taskId: "task",
  runId: "run",
  traceId: "run",
};
function delivery(
  index: number,
  eventId = `event-${index}`,
  purpose: shared.TaskRealtimeDeliveryPurpose = "observer",
) {
  return {
    type: shared.HostMessageTypes.TaskRealtimeDeliver,
    event: {
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      workspaceKey: target.workspaceKey,
      taskId: target.taskId,
      traceId: target.traceId,
      eventId,
      type: "task_snapshot_invalidated",
      reason: "task_meta_changed",
      createdAt: index,
      originHostId: "owner",
      deliveryPurpose: purpose,
    },
  };
}

function fixture(
  create = createTaskRealtimeBridgeForHostInit,
  kind: shared.TaskRealtimeHostDeliveryKind = "desktop_window",
) {
  const parentPort = Object.assign(new EventEmitter(), { postMessage: vi.fn() });
  const bridge = create(
    { type: shared.HostMessageTypes.InitLocal, hostId: "host", deliveryKind: kind },
    parentPort,
  )!;
  const received: shared.TaskRealtimeDeliveredEvent[] = [];
  bridge.onDidReceiveEvent((event) => received.push(event));
  return {
    bridge,
    parentPort,
    received,
    send: (message: unknown) => parentPort.emit("message", { data: message }),
  };
}

describe("constant-work Host realtime deduplication preserves delivery", () => {
  it.each(["desktop_window", "relay_bridge"] as const)(
    "preserves 1000-event eviction without refreshing duplicates (%s)",
    (kind) => {
      const current = fixture(createTaskRealtimeBridgeForHostInit, kind);
      const before = fixture(original, kind);
      const send = (message: unknown) => {
        current.send(message);
        before.send(message);
      };
      for (let index = 0; index < 1000; index++) send(delivery(index));
      send(delivery(2000, "event-0"));
      expect(current.received).toHaveLength(1000);
      send(delivery(1000));
      send(delivery(2001, "event-0"));
      expect(current.received).toHaveLength(1002);
      expect(current.received).toEqual(before.received);
      send(delivery(2002, "event-999"));
      expect(current.received).toHaveLength(1002);
      current.bridge.dispose();
      before.bridge.dispose();
      expect(current.parentPort.listenerCount("message")).toBe(0);
    },
  );

  it("matches original deliveries across repeated IDs, invalid frames and purposes", () => {
    for (let seed = 1; seed <= 12; seed++) {
      const next = linearRandom(seed);
      const current = fixture();
      const before = fixture(original);
      for (let index = 0; index < 2200; index++) {
        let message: unknown = delivery(
          index,
          `event-${next(1800)}`,
          index % 2 ? "observer" : "relay_owner",
        );
        if (index % 137 === 0)
          message = {
            type: shared.HostMessageTypes.TaskRealtimeDeliver,
            event: { ...delivery(index).event, workspaceKey: "wrong-identity" },
          };
        if (index % 181 === 0)
          message = { type: shared.HostMessageTypes.TaskRealtimeDeliver, event: {} };
        current.send(message);
        before.send(message);
      }
      expect(current.received).toEqual(before.received);
      current.bridge.dispose();
      before.bridge.dispose();
    }
  });

  it("isolates bridge instances and retains publish, listener and disposal boundaries", () => {
    expect(shared.hostIncomingMessageSchema.safeParse(delivery(1)).success).toBe(true);
    const a = fixture();
    const b = fixture();
    a.send(delivery(1));
    b.send(delivery(1));
    expect(a.received).toEqual(b.received);
    const extra = vi.fn();
    const subscription = a.bridge.onDidReceiveEvent(extra);
    a.send(delivery(2));
    subscription.dispose();
    a.send(delivery(3));
    expect(extra).toHaveBeenCalledTimes(1);
    const { originHostId: _origin, deliveryPurpose: _purpose, ...event } = a.received[0]!;
    a.bridge.publish(event);
    expect(a.parentPort.postMessage).toHaveBeenLastCalledWith({
      type: shared.HostResponseTypes.TaskRealtimePublish,
      event,
    });
    a.bridge.dispose();
    a.bridge.dispose();
    a.send(delivery(4));
    a.bridge.publish(event);
    expect(a.received).toHaveLength(3);
    expect(a.bridge.onDidReceiveEvent(extra).dispose()).toBeUndefined();
    expect(a.parentPort.listenerCount("message")).toBe(0);
    b.send(delivery(5));
    expect(b.received).toHaveLength(2);
    b.bridge.dispose();
  });

  it("keeps lease and owner-command results exactly routed and pending work rejected on close", async () => {
    const f = fixture();
    const lease = f.bridge.acquireTaskRunLease(target);
    const leaseRequestId = f.parentPort.postMessage.mock.calls.at(-1)![0].request.leaseRequestId;
    const result = { leaseRequestId, acquired: true, ownerHostId: "owner" };
    f.send({ type: shared.HostMessageTypes.TaskRunLeaseResult, result });
    await expect(lease).resolves.toEqual(result);
    const { traceId: _trace, ...commandTarget } = target;
    const request: Parameters<SessionRealtimePort["requestOwnerCommand"]>[0] = {
      type: "stop_generation",
      ...commandTarget,
    };
    const command = f.bridge.requestOwnerCommand(request);
    const commandRequestId =
      f.parentPort.postMessage.mock.calls.at(-1)![0].command.commandRequestId;
    const commandResult = {
      commandRequestId,
      success: false,
      error: "stale",
      code: "STALE_TASK_OWNER_COMMAND",
    };
    f.send({ type: shared.HostMessageTypes.TaskOwnerCommandResult, result: commandResult });
    await expect(command).resolves.toEqual(commandResult);
    const ownerListener = vi.fn();
    f.bridge.onDidReceiveOwnerCommand(ownerListener);
    f.send({
      type: shared.HostMessageTypes.TaskOwnerCommandDeliver,
      command: { ...request, commandRequestId: "incoming", requesterHostId: "requester" },
    });
    expect(ownerListener).toHaveBeenCalledTimes(1);
    const pendingLease = f.bridge.acquireTaskRunLease(target);
    const pendingCommand = f.bridge.requestOwnerCommand(request);
    const leaseFailure = expect(pendingLease).rejects.toThrow("task realtime bridge disposed");
    const commandFailure = expect(pendingCommand).rejects.toThrow("task realtime bridge disposed");
    f.bridge.dispose();
    await Promise.all([leaseFailure, commandFailure]);
    await expect(f.bridge.acquireTaskRunLease(target)).rejects.toThrow("disposed");
    await expect(f.bridge.requestOwnerCommand(request)).rejects.toThrow("disposed");
  });

  it("does not shift a 1000-item ID array for each new event", () => {
    const f = fixture();
    for (let index = 0; index < 1000; index++) f.send(delivery(index));
    const originalShift = Array.prototype.shift;
    let calls = 0;
    Reflect.set(Array.prototype, "shift", function (this: unknown[]) {
      calls++;
      return originalShift.call(this);
    });
    try {
      for (let index = 1000; index < 3000; index++) f.send(delivery(index));
    } finally {
      Reflect.set(Array.prototype, "shift", originalShift);
    }
    expect(f.received).toHaveLength(3000);
    expect(calls).toBe(0);
    f.bridge.dispose();
  });

  it("records schema-validated delivery time without timing gates", () => {
    const messages = Array.from({ length: 20_000 }, (_, index) => delivery(index));
    const run = (create: typeof original) => {
      const f = fixture(create);
      for (const message of messages) f.send(message);
      f.bridge.dispose();
    };
    console.info(
      "PERFORMANCE_LINEAR",
      JSON.stringify(
        measureLinearHotpath(
          "Host realtime 20000 unique IDs / window 1000",
          () => run(original),
          () => run(createTaskRealtimeBridgeForHostInit),
        ),
      ),
    );
  });
});
