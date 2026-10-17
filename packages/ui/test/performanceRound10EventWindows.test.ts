import { afterEach, expect, it, vi } from "vitest";
import type { ZCodeComputerUseOperationEvent, ZCodeSessionEvent } from "@zcode/shared";
import { createCuaOperationTurnTracker } from "../../services/src/zcode-agent/cuaOperationTurnTracker.js";
import { createZCodeAgentService } from "../../services/src/zcode-agent/zcodeAgentService.js";
import { BoundedEventIdOrder } from "../../services/src/zcode-agent/boundedEventIdOrder.js";

const fixture = vi.hoisted(() => ({
  notify: undefined as undefined | ((message: { method: string; params: unknown }) => void),
  replay: [] as ZCodeSessionEvent[],
}));
vi.mock("../../services/src/session/automationRepo.js", () => ({
  AutomationRepo: class {
    close() {}
  },
}));
vi.mock("../../services/src/session/taskIndexRepo.js", () => ({
  TaskIndexRepo: class {
    close() {}
  },
}));
vi.mock("../../services/src/zcode-agent/zcodeAgentProcessManager.js", () => {
  const disposable = () => ({ dispose() {} });
  const makeClient = () => ({
    onNotification(listener: typeof fixture.notify) {
      fixture.notify = listener;
      return disposable();
    },
    onRequest: disposable,
    onClose: disposable,
    request: async () => ({ events: fixture.replay }),
  });
  return {
    ZCodeAgentProcessManager: class {
      clients = new Map<string, ReturnType<typeof makeClient>>();
      clientFor(params: { workspacePath: string; workspaceIdentity?: string }) {
        const key = params.workspaceIdentity || params.workspacePath;
        if (!this.clients.has(key)) this.clients.set(key, makeClient());
        return this.clients.get(key)!;
      }
      onRuntimeRestarted = disposable;
      onRuntimeLifecycle = disposable;
      async getClient(params: { workspacePath: string; workspaceIdentity?: string }) {
        return this.clientFor(params);
      }
      getExistingClient(params: { workspacePath: string; workspaceIdentity?: string }) {
        return this.clientFor(params);
      }
      disposeAll() {}
    },
  };
});

afterEach(() => {
  fixture.notify = undefined;
  fixture.replay = [];
  vi.restoreAllMocks();
});

function countWindowShifts(run: () => void): number {
  const original = Array.prototype.shift;
  let shifts = 0;
  Array.prototype.shift = function (this: unknown[]) {
    if (typeof this[0] === "string" && this[0].includes("window-fixture-")) shifts += 1;
    return original.call(this);
  };
  try {
    run();
  } finally {
    Array.prototype.shift = original;
  }
  return shifts;
}

function cua(
  index: number,
  patch: Partial<ZCodeComputerUseOperationEvent> = {},
): ZCodeComputerUseOperationEvent {
  return {
    kind: "turn-completed",
    eventId: `window-fixture-cua-${index}`,
    sequenceNumber: index,
    sessionId: "session",
    turnId: `turn-${index}`,
    timestamp: index,
    ...patch,
  } as ZCodeComputerUseOperationEvent;
}

function event(index: number, seq = 0, sessionId = "session"): ZCodeSessionEvent {
  return {
    type: "session.updated",
    eventId: `window-fixture-session-${index}`,
    seq,
    sessionId,
    timestamp: index,
  };
}

async function settleSubscription() {
  for (let index = 0; index < 30; index += 1) await Promise.resolve();
}

it("does not shift saturated CUA seen-event and retired-turn windows", () => {
  const tracker = createCuaOperationTurnTracker({});
  const shifts = countWindowShifts(() => {
    for (let index = 0; index < 10_000; index += 1)
      tracker.accept({ workspacePath: "window-fixture-workspace" }, cua(index));
  });
  expect(shifts).toBe(0);
});

it("does not shift saturated Host compatibility, live, or listener windows", async () => {
  const service = createZCodeAgentService();
  const delivered: ZCodeSessionEvent[] = [];
  const subscription = service.onDynamicSessionEvent({
    workspacePath: "window-fixture-workspace",
    sessionId: "session",
  })((value) => {
    if (value.type === "session.event") delivered.push(value.event);
  });
  await settleSubscription();
  try {
    expect(fixture.notify).toBeTypeOf("function");
    const shifts = countWindowShifts(() => {
      for (let index = 0; index < 12_000; index += 1)
        fixture.notify!({ method: "session/event", params: event(index) });
    });
    expect(delivered).toHaveLength(12_000);
    expect(delivered[11_999]?.seq).toBe(12_000);
    expect(shifts).toBe(0);
  } finally {
    subscription.dispose();
    service.disposeAll();
  }
});

it("matches a plain FIFO through repeated wrap, selective removal and clear", () => {
  for (const capacity of [1, 2, 7, 29]) {
    const order = new BoundedEventIdOrder(capacity);
    let expected: string[] = [];
    for (let index = 0; index < 1500; index += 1) {
      if (index % 113 === 0) {
        order.clear();
        expected = [];
      } else if (index % 37 === 0) {
        const matches = (key: string) => Number(key) % 3 === 0;
        expect(order.removeWhere(matches)).toEqual(expected.filter(matches));
        expected = expected.filter((key) => !matches(key));
      } else {
        expected.push(String(index));
        expect(order.push(String(index))).toBe(
          expected.length > capacity ? expected.shift() : undefined,
        );
      }
    }
    expect(order.removeWhere(() => true)).toEqual(expected);
    expect(order.removeWhere(() => true)).toEqual([]);
  }
});

it("keeps exact session FIFO capacity and duplicate insertion order with monotonic compatibility seq", async () => {
  const service = createZCodeAgentService();
  const delivered: ZCodeSessionEvent[] = [];
  const subscription = service.onDynamicSessionEvent({
    workspacePath: "window-fixture-workspace",
    sessionId: "session",
  })((value) => {
    if (value.type === "session.event") delivered.push(value.event);
  });
  await settleSubscription();
  const send = (value: ZCodeSessionEvent) =>
    fixture.notify!({ method: "session/event", params: value });
  try {
    for (let index = 0; index < 10_000; index += 1) send(event(index));
    send(event(0));
    expect(delivered).toHaveLength(10_000);
    send(event(10_000, 20_000));
    send(event(1));
    expect(delivered).toHaveLength(10_001);
    send(event(0));
    expect(delivered.at(-1)).toMatchObject({ eventId: event(0).eventId, seq: 1 });
    send(event(10_001));
    expect(delivered.at(-1)?.seq).toBe(20_001);
    // 补号窗口只接纳 seq=0；再来一条后才淘汰原 0，下一次按当前基线重新补号。
    send(event(10_002));
    send(event(0));
    expect(delivered.at(-1)?.seq).toBe(20_002);
    fixture.replay = [event(0)];
    const replayed: ZCodeSessionEvent[] = [];
    const replay = service.onDynamicSessionEvent({
      workspacePath: "window-fixture-workspace",
      sessionId: "session",
    })((value) => {
      if (value.type === "session.event") replayed.push(value.event);
    });
    await settleSubscription();
    expect(replayed[0]?.seq).toBe(20_003);
    replay.dispose();
  } finally {
    subscription.dispose();
    service.disposeAll();
  }
});

it("keeps replay per subscriber and deduplicates buffered live with workspace/session isolation", async () => {
  const service = createZCodeAgentService();
  const target = {
    workspacePath: "window-fixture-same-path",
    workspaceIdentity: "window-fixture-remote-a",
    sessionId: "session",
  };
  const first: ZCodeSessionEvent[] = [];
  const second: ZCodeSessionEvent[] = [];
  const third: ZCodeSessionEvent[] = [];
  const collect =
    (list: ZCodeSessionEvent[]) =>
    (value: Parameters<Parameters<ReturnType<typeof service.onDynamicSessionEvent>>[0]>[0]) => {
      if (value.type === "session.event") list.push(value.event);
    };
  fixture.replay = [event(2, 3), event(0, 1), event(1, 2)];
  const a = service.onDynamicSessionEvent(target)(collect(first));
  await settleSubscription();
  expect(first.map((value) => value.seq)).toEqual([1, 2, 3]);
  fixture.replay = [event(1, 2), event(2, 3)];
  const b = service.onDynamicSessionEvent(target)(collect(second));
  // 订阅请求尚未返回时先进入 live；该事件与 replay 重复，只应投递一次。
  fixture.notify!({ method: "session/event", params: event(2, 3) });
  await settleSubscription();
  expect(first.map((value) => value.seq)).toEqual([1, 2, 3]);
  expect(second.map((value) => value.seq)).toEqual([2, 3]);
  fixture.notify!({ method: "session/event", params: event(3, 4) });
  expect(first.at(-1)?.seq).toBe(4);
  expect(second.at(-1)?.seq).toBe(4);
  a.dispose();
  fixture.notify!({ method: "session/event", params: event(4, 5) });
  expect(first.at(-1)?.seq).toBe(4);
  expect(second.at(-1)?.seq).toBe(5);
  fixture.replay = [];
  const c = service.onDynamicSessionEvent({
    ...target,
    workspaceIdentity: "window-fixture-remote-b",
  })(collect(third));
  await settleSubscription();
  fixture.notify!({ method: "session/event", params: event(3, 0) });
  fixture.notify!({ method: "session/event", params: event(3, 0, "other-session") });
  expect(third.map((value) => value.seq)).toEqual([1]);
  expect(second.at(-1)?.seq).toBe(5);
  b.dispose();
  c.dispose();
  service.disposeAll();
});

it("does not refresh duplicate retired-turn FIFO and permits the oldest turn only after eviction", () => {
  const reports: boolean[] = [];
  const tracker = createCuaOperationTurnTracker({
    reporter: { onStateChanged: (value) => reports.push(value.active) },
  });
  const workspace = { workspacePath: "window-fixture-workspace" };
  let eventId = 100_000;
  const retire = (index: number) =>
    tracker.accept(
      workspace,
      cua(eventId++, { sequenceNumber: 0, sessionId: `session-${index}`, turnId: `turn-${index}` }),
    );
  const activate = (index: number) => {
    const common = {
      sequenceNumber: 0,
      sessionId: `session-${index}`,
      turnId: `turn-${index}`,
      toolCallId: "tool",
      toolName: "fixture",
    };
    tracker.accept(
      workspace,
      cua(eventId++, { ...common, kind: "tool-scheduled", computerUse: true }),
    );
    tracker.accept(workspace, cua(eventId++, { ...common, kind: "tool-started" }));
  };
  for (let index = 0; index < 2048; index += 1) retire(index);
  retire(0);
  retire(2048);
  activate(1);
  expect(reports).toEqual([]);
  activate(0);
  expect(reports).toEqual([true]);
  tracker.clearAll();
  expect(reports).toEqual([true, false]);
  activate(1);
  expect(reports).toEqual([true, false, true]);
});

it("keeps CUA seen-event capacity exactly 8192 without refreshing duplicate order", () => {
  const reports: boolean[] = [];
  const tracker = createCuaOperationTurnTracker({
    reporter: { onStateChanged: (value) => reports.push(value.active) },
  });
  const workspace = { workspacePath: "window-fixture-workspace" };
  const scheduled = cua(0, {
    kind: "tool-scheduled",
    computerUse: true,
    toolCallId: "tool",
    toolName: "fixture",
    sequenceNumber: 0,
  });
  const started = cua(1, {
    kind: "tool-started",
    turnId: scheduled.turnId,
    toolCallId: "tool",
    sequenceNumber: 0,
  });
  tracker.accept(workspace, scheduled);
  tracker.accept(workspace, started);
  for (let index = 2; index < 8192; index += 1)
    tracker.accept(
      workspace,
      cua(index, { kind: "session-closed", sessionId: "filler", sequenceNumber: 0 }),
    );
  tracker.accept(workspace, { ...scheduled, eventId: "window-fixture-re-schedule" });
  tracker.accept(workspace, started);
  expect(reports).toEqual([true]);
  tracker.accept(
    workspace,
    cua(8192, { kind: "session-closed", sessionId: "filler", sequenceNumber: 0 }),
  );
  tracker.accept(workspace, started);
  expect(reports).toEqual([true, true]);
});

it("removes one workspace from wrapped CUA orders while retaining the other workspace FIFO", () => {
  const reports: Array<{ active: boolean; sessionId: string; workspaceIdentity?: string }> = [];
  const tracker = createCuaOperationTurnTracker({
    reporter: { onStateChanged: (value) => reports.push(value) },
  });
  const a = { workspacePath: "window-fixture-same-path", workspaceIdentity: "window-fixture-a" };
  const b = { ...a, workspaceIdentity: "window-fixture-b" };
  let eventId = 100_000;
  const retire = (index: number, workspace = index % 2 === 0 ? a : b) =>
    tracker.accept(
      workspace,
      cua(eventId++, { sessionId: `session-${index}`, turnId: `turn-${index}`, sequenceNumber: 0 }),
    );
  const activate = (index: number, workspace: typeof a) => {
    const common = {
      sessionId: `session-${index}`,
      turnId: `turn-${index}`,
      sequenceNumber: 0,
      toolCallId: "tool",
      toolName: "fixture",
    };
    tracker.accept(
      workspace,
      cua(eventId++, { ...common, kind: "tool-scheduled", computerUse: true }),
    );
    tracker.accept(workspace, cua(eventId++, { ...common, kind: "tool-started" }));
  };
  activate(50_000, a);
  activate(50_000, b);
  for (let index = 0; index < 10_000; index += 1) retire(index);
  tracker.clearWorkspaceKey(a.workspaceIdentity);
  expect(reports.map((value) => [value.workspaceIdentity, value.active])).toEqual([
    [a.workspaceIdentity, true],
    [b.workspaceIdentity, true],
    [a.workspaceIdentity, false],
  ]);
  activate(9_998, a);
  expect(reports.at(-1)).toMatchObject({
    active: true,
    workspaceIdentity: a.workspaceIdentity,
    sessionId: "session-9998",
  });
  const before = reports.length;
  // 满窗 2,048 项的后半段有 1,024 个 B；清理 A 后顺序仍以 B 的 7,953 开头。
  for (let index = 10_000; index < 11_024; index += 1) retire(index, b);
  activate(7_953, b);
  expect(reports).toHaveLength(before);
  retire(11_024, b);
  activate(7_953, b);
  expect(reports.at(-1)).toMatchObject({
    active: true,
    workspaceIdentity: b.workspaceIdentity,
    sessionId: "session-7953",
  });
  const after = reports.length;
  activate(7_955, b);
  expect(reports).toHaveLength(after);
  tracker.clearAll();
  expect(tracker.hasActiveTurn()).toBe(false);
});
