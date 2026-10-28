import { EventEmitter } from "node:events";
import type { UtilityProcess } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HostResponseTypes,
  type TaskRealtimeEvent,
  type TaskRealtimeHostDeliveryKind,
} from "@zcode/shared";
import { TaskRealtimeBus } from "./taskRealtimeBus.js";

vi.mock("./logger.js", () => ({ logger: { info() {}, warn() {} } }));
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const workspace = {
  workspacePath: "C:/synthetic",
  workspaceIdentity: "synthetic-identity",
  workspaceKey: "synthetic-identity",
};
function publish(index: number, eventId = `event-${index}`) {
  const event: TaskRealtimeEvent = {
    ...workspace,
    type: "task_snapshot_invalidated",
    taskId: "task",
    traceId: "run",
    eventId,
    createdAt: index,
    reason: "task_meta_changed",
  };
  return { type: HostResponseTypes.TaskRealtimePublish, event };
}

// 只保留修改前的小方法作为 oracle；两版都走实际 Bus 的 schema、Host 和投递入口。
function originalRemember(limit: number) {
  const ids = new Set<string>();
  const order: string[] = [];
  return (eventId: string): boolean => {
    if (ids.has(eventId)) return false;
    ids.add(eventId);
    order.push(eventId);
    while (order.length > limit) {
      const removed = order.shift();
      if (removed) ids.delete(removed);
    }
    return true;
  };
}

function fixture(limit?: number, original = false) {
  const messages: unknown[] = [];
  const logs: unknown[] = [];
  const children = new Map<string, EventEmitter>();
  const bus = new TaskRealtimeBus({
    seenEventLimit: limit,
    logger: {
      info: (...args: unknown[]) => logs.push(["info", ...args]),
      warn: (...args: unknown[]) => logs.push(["warn", ...args]),
    },
  });
  if (original) Reflect.set(bus, "rememberEventId", originalRemember(limit ?? 1000));
  const register = (
    hostId: string,
    kind: TaskRealtimeHostDeliveryKind = "desktop_window",
    keys = [workspace.workspaceKey],
  ) => {
    const child = Object.assign(new EventEmitter(), {
      postMessage: (message: unknown) => messages.push({ hostId, message }),
    });
    children.set(hostId, child);
    bus.registerHost({
      hostId,
      windowId: hostId === "owner" ? 1 : 2,
      child: child as unknown as UtilityProcess,
      workspaceKeys: keys,
      deliveryKind: kind,
    });
    return child;
  };
  return {
    bus,
    messages,
    logs,
    register,
    send: (message: unknown, hostId = "owner") => children.get(hostId)!.emit("message", message),
    unregister: (hostId: string) => bus.unregisterHost(hostId),
    dispose: () => {
      for (const hostId of children.keys()) bus.unregisterHost(hostId);
    },
  };
}

interface SeenWindow {
  seenEventIds: Set<string>;
  seenEventOrder: Array<string | undefined>;
  seenEventHead?: number;
}

function windowOf(bus: TaskRealtimeBus): SeenWindow {
  return bus as unknown as SeenWindow;
}

describe("Main realtime eventId FIFO keeps public delivery semantics", () => {
  it.each(["desktop_window", "relay_bridge"] as const)(
    "does not refresh duplicate IDs or reset them on Host replacement (%s)",
    (kind) => {
      const current = fixture();
      const original = fixture(undefined, true);
      for (const f of [current, original]) {
        f.register("owner");
        f.register("observer", kind);
        f.register("outsider", kind, ["other-identity"]);
        for (let index = 0; index < 1000; index++) f.send(publish(index));
        f.send(publish(2000, "event-0"));
        expect(f.messages).toHaveLength(2000);
        f.send(publish(1000));
        f.send(publish(2001, "event-0"));
        f.send(publish(2002, "event-999"), "observer");
        expect(f.messages).toHaveLength(2004);
        const oldChild = f.register("owner");
        f.send(publish(2003, "event-0"));
        expect(f.messages).toHaveLength(2004);
        f.unregister("owner");
        expect(oldChild.listenerCount("message")).toBe(0);
        f.register("owner");
        f.send(publish(2004, "event-0"));
        expect(f.messages).toHaveLength(2004);
        f.dispose();
      }
      expect(current.messages).toEqual(original.messages);
      expect(current.logs).toEqual(original.logs);
    },
  );

  it.each([undefined, 0, 0.25, 0.5, 1, 1.5, 2, 2.75, 7, 1000, NaN, Infinity])(
    "matches the original capacity comparison without normalization (%s)",
    (limit) => {
      const current = fixture(limit);
      const original = fixture(limit, true);
      for (const f of [current, original]) {
        f.register("owner");
        for (let index = 0; index < 1200; index++) {
          f.send(publish(index));
          if (index % 7 === 0) f.send(publish(index + 2000, `event-${index}`));
          if (index % 19 === 0) f.send(publish(index + 4000, "event-0"));
        }
        f.dispose();
      }
      expect(current.messages).toEqual(original.messages);
      expect(current.logs).toEqual(original.logs);
    },
  );

  it("matches complete messages and logs across repeated IDs, invalid frames and Host generations", () => {
    for (let seed = 1; seed <= 4; seed++) {
      let random = seed;
      const current = fixture(31);
      const original = fixture(31, true);
      for (const f of [current, original]) {
        f.register("owner");
        f.register("observer", "relay_bridge");
      }
      for (let index = 0; index < 3000; index++) {
        random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
        const message = publish(index, `event-${random % 47}`);
        const input: unknown = index % 137 === 0 ? { ...message, event: {} } : message;
        for (const f of [current, original]) {
          if (index % 499 === 0) {
            f.unregister("owner");
            f.register("owner");
          }
          f.send(input, index % 2 ? "observer" : "owner");
        }
      }
      for (const f of [current, original]) f.dispose();
      expect(current.messages).toEqual(original.messages);
      expect(current.logs).toEqual(original.logs);
    }
  });

  it("releases consumed references and keeps live IDs and backing storage bounded", () => {
    const f = fixture();
    f.register("owner");
    try {
      for (let index = 0; index < 10_000; index++) {
        f.send(publish(index));
        const state = windowOf(f.bus);
        const head = state.seenEventHead ?? 0;
        expect(state.seenEventIds.size).toBe(Math.min(index + 1, 1000));
        expect(state.seenEventOrder.length).toBeLessThanOrEqual(2024);
        expect(state.seenEventOrder.slice(0, head).every((value) => value === undefined)).toBe(
          true,
        );
      }
      const state = windowOf(f.bus);
      expect(state.seenEventOrder.slice(state.seenEventHead ?? 0)).toEqual(
        Array.from({ length: 1000 }, (_, index) => `event-${index + 9000}`),
      );
    } finally {
      f.dispose();
    }
  });

  it("does amortized linear array work after the 1000-ID window fills", () => {
    const f = fixture();
    f.register("owner");
    for (let index = 0; index < 1000; index++) f.send(publish(index));
    const state = windowOf(f.bus);
    let indexWrites = 0;
    let copiedSlots = 0;
    const track = (values: Array<string | undefined>) =>
      new Proxy(values, {
        set(target, key, value, receiver) {
          if (typeof key === "string" && /^(0|[1-9]\d*)$/.test(key)) indexWrites++;
          return Reflect.set(target, key, value, receiver);
        },
        get(target, key, receiver) {
          if (key === "slice")
            return (start?: number, end?: number) => {
              const copy = target.slice(start, end);
              copiedSlots += copy.length;
              return copy;
            };
          return Reflect.get(target, key, receiver);
        },
      });
    let backing = track(state.seenEventOrder);
    Object.defineProperty(state, "seenEventOrder", {
      configurable: true,
      get: () => backing,
      set: (values: Array<string | undefined>) => {
        backing = track(values);
      },
    });
    const shift = vi.spyOn(Array.prototype, "shift");
    try {
      for (let index = 1000; index < 3000; index++) f.send(publish(index));
      expect(f.messages).toHaveLength(3000);
      expect(state.seenEventIds.size).toBe(1000);
      process.stdout.write(
        `MAIN_FIFO_WORK ${JSON.stringify({ inputs: 2000, indexWrites, copiedSlots, shifts: shift.mock.calls.length })}\n`,
      );
      expect(indexWrites + copiedSlots).toBeLessThanOrEqual(6000);
      expect(shift).not.toHaveBeenCalled();
    } finally {
      shift.mockRestore();
      f.dispose();
    }
  });
});
