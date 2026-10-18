import { describe, expect, it, vi } from "vitest";
import {
  conversationTopic,
  conversationSnapshotSchema,
  type ConversationSnapshot,
  type ConversationTopicFrame,
  type TopicFrameDeliveryKind,
} from "@zcode/shared/zcode-protocol-v4";
import {
  type ConversationStoreState,
  type ConversationTransport,
} from "@zcode/ui/conversation-client";
import { TaskConversationLifecycle } from "./taskConversationLifecycle.js";

const scope = {
  workspaceKey: "workspace-a",
  workspacePath: "/workspace/a",
  workspaceIdentity: "workspace-a-id",
  remoteSessionId: "remote-a",
  taskId: "session-a",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function snapshot(text: string, seq = 5): ConversationSnapshot {
  return conversationSnapshotSchema.parse({
    protocolVersion: 1,
    sessionId: scope.taskId,
    logEpoch: "epoch-1",
    seq,
    revision: 0,
    meta: { title: "fixture", titleSource: "default" },
    control: {
      phase: "running",
      sessionEnded: false,
      canStop: true,
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
    config: {
      provider: "test",
      model: "test",
      thought: "",
      thoughtLevels: [],
      mode: "build",
      followupMode: "queue",
    },
    modelTransition: null,
    usage: {
      contextWindow: null,
      cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    queue: { items: [], autoDrain: true },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    workspaceHookAdmission: null,
    goal: null,
    plan: null,
    rows: {
      window: [
        {
          rowId: 1,
          turnId: "turn-1",
          createdAt: 1,
          createdAtSeq: 1,
          kind: "userInput",
          origin: "realUser",
          text: "question",
        },
        {
          rowId: 2,
          turnId: "turn-1",
          createdAt: 2,
          createdAtSeq: 2,
          kind: "assistantText",
          state: "streaming",
          text,
        },
      ],
      totalCount: 2,
      firstRowId: 1,
    },
  });
}

function snapshotFrame(
  subscriptionId: string,
  projection: ConversationSnapshot,
): ConversationTopicFrame {
  return {
    topic: conversationTopic(scope.taskId),
    subscriptionId,
    fromSeq: 0,
    toSeq: projection.seq,
    sentAt: 1,
    payload: { kind: "snapshot", snapshot: projection },
  };
}

function deferredAck() {
  return deferred<Awaited<ReturnType<ConversationTransport["subscribe"]>>>();
}

function transportFixture(options: { holdAck?: boolean; subscribeError?: Error } = {}) {
  const listeners = new Set<Parameters<ConversationTransport["onFrame"]>[0]>();
  const queued: { frame: ConversationTopicFrame; deliveryKind: TopicFrameDeliveryKind }[] = [];
  const ack = deferredAck();
  let subscriptionCount = 0;
  let activated = false;
  let subscriptionId = "";
  const transport = {
    subscribe: vi.fn(async () => {
      subscriptionId = `sub-${++subscriptionCount}`;
      if (options.subscribeError) throw options.subscribeError;
      return options.holdAck
        ? ack.promise
        : {
            ack: { subscriptionId, mode: "snapshot" as const, logEpoch: "epoch-1" },
          };
    }),
    activate: vi.fn((activeSubscriptionId: string) => {
      activated = true;
      for (const item of queued.splice(0)) deliver(item.frame, item.deliveryKind);
      expect(activeSubscriptionId).toBe(subscriptionId);
    }),
    unsubscribe: vi.fn(async () => {}),
    resync: vi.fn(async (params) => ({
      ack: {
        subscriptionId: params.subscriptionId,
        mode: params.forceSnapshot ? ("snapshot" as const) : ("resume" as const),
        logEpoch: "epoch-1",
      },
    })),
    rowsRange: vi.fn(async () => ({
      rows: [],
      atSeq: 0,
      atRevision: 0,
      atLogEpoch: "epoch-1",
      hasMore: false,
    })),
    onFrame: (listener: Parameters<ConversationTransport["onFrame"]>[0]) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onAssemblyFault: () => () => {},
    onRuntimeRestart: () => () => {},
  } as unknown as ConversationTransport;

  function deliver(frame: ConversationTopicFrame, deliveryKind: TopicFrameDeliveryKind) {
    for (const listener of listeners) listener(frame, { deliveryKind });
  }

  return {
    transport,
    get subscriptionId() {
      return subscriptionId;
    },
    captureFrameCallbacks: () => [...listeners],
    emit(frame: ConversationTopicFrame, deliveryKind: TopicFrameDeliveryKind = "online") {
      if (!activated) queued.push({ frame, deliveryKind });
      else deliver(frame, deliveryKind);
    },
    resolveAck() {
      ack.resolve({
        ack: { subscriptionId, mode: "snapshot", logEpoch: "epoch-1" },
      });
    },
  };
}

async function flush() {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

function harness(options: {
  transports: ReturnType<typeof transportFixture>[];
  prepare?: () => Promise<void>;
}) {
  let openIndex = 0;
  const states: ConversationStoreState[] = [];
  const onError = vi.fn();
  const prepare = options.prepare ?? vi.fn(async () => {});
  const lifecycle = new TaskConversationLifecycle(scope, {
    prepare,
    open: vi.fn(async () => options.transports[openIndex++]!.transport),
    onState: (state) => states.push(state),
    onError,
  });
  return { lifecycle, states, onError, prepare };
}

describe("TaskConversationLifecycle V4 adapter", () => {
  it("waits for the activated initial snapshot, then applies its prefix and only the next delta", async () => {
    const fixture = transportFixture({ holdAck: true });
    const h = harness({ transports: [fixture] });
    h.lifecycle.start();
    await flush();

    const initial = snapshotFrame(fixture.subscriptionId, snapshot("generated prefix"));
    fixture.emit(initial, "initial");
    expect(h.lifecycle.ready).toBe(false);
    expect(h.lifecycle.store?.getState().snapshot).toBeNull();

    fixture.resolveAck();
    await flush();
    expect(h.states).toContainEqual(
      expect.objectContaining({ status: "connecting", snapshot: null }),
    );
    expect(h.lifecycle.ready).toBe(true);
    expect(h.lifecycle.store?.getState().snapshot?.rows.window).toHaveLength(2);

    fixture.emit({
      topic: conversationTopic(scope.taskId),
      subscriptionId: fixture.subscriptionId,
      fromSeq: 5,
      toSeq: 6,
      sentAt: 2,
      payload: {
        kind: "deltas",
        deltas: [{ op: "row.delta", rowId: 2, path: "text", append: " plus delta" }],
      },
    });
    const rows = h.lifecycle.store?.getState().snapshot?.rows.window;
    expect(rows).toHaveLength(2);
    expect(rows?.[1]).toMatchObject({ text: "generated prefix plus delta" });
    expect(h.onError).not.toHaveBeenCalled();
    h.lifecycle.dispose();
    await flush();
  });

  it("same-scope recovery keeps the displayed snapshot connecting and rejects old frames", async () => {
    const first = transportFixture();
    const second = transportFixture();
    const h = harness({ transports: [first, second] });
    h.lifecycle.start();
    await flush();
    first.emit(snapshotFrame(first.subscriptionId, snapshot("old visible")), "initial");
    await flush();

    const oldStore = h.lifecycle.store!;
    const oldSnapshot = oldStore.getState().snapshot!;
    const oldFrameCallback = first.captureFrameCallbacks()[0]!;
    h.lifecycle.recoverBridge();
    expect(h.states.at(-1)).toMatchObject({ status: "connecting", snapshot: oldSnapshot });
    await flush();

    const newStore = h.lifecycle.store!;
    expect(newStore).not.toBe(oldStore);
    expect(newStore.getState().snapshot).toBeNull();
    expect(h.lifecycle.ready).toBe(false);

    oldFrameCallback(snapshotFrame(first.subscriptionId, snapshot("stale old frame")), {
      deliveryKind: "initial",
    });
    expect(newStore.getState().snapshot).toBeNull();

    second.emit(snapshotFrame(second.subscriptionId, snapshot("new projection", 8)), "initial");
    expect(h.lifecycle.store?.getState().snapshot?.rows.window[1]).toMatchObject({
      text: "new projection",
    });
    expect(h.lifecycle.ready).toBe(true);
    expect(h.onError).not.toHaveBeenCalled();
    h.lifecycle.dispose();
    await flush();
    expect(first.transport.unsubscribe).toHaveBeenCalledTimes(1);
    expect(second.transport.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("surfaces recovery subscription failure while preserving the last visible snapshot", async () => {
    const first = transportFixture();
    const failedRecovery = transportFixture({ subscribeError: new Error("recovery denied") });
    const h = harness({ transports: [first, failedRecovery] });
    h.lifecycle.start();
    await flush();
    first.emit(snapshotFrame(first.subscriptionId, snapshot("old visible")), "initial");
    await flush();
    const oldSnapshot = h.lifecycle.store?.getState().snapshot;
    expect(oldSnapshot).not.toBeNull();

    h.lifecycle.recoverBridge();
    expect(h.states.at(-1)).toMatchObject({ status: "connecting", snapshot: oldSnapshot });
    await flush();

    expect(h.states.at(-1)).toMatchObject({ status: "error", snapshot: oldSnapshot });
    expect(h.onError).toHaveBeenCalledTimes(1);
    expect(h.onError).toHaveBeenCalledWith(expect.objectContaining({ message: "recovery denied" }));
    expect(h.lifecycle.ready).toBe(false);
    h.lifecycle.dispose();
    await flush();
  });

  it("surfaces a recovery prepare failure instead of leaving the preserved snapshot connecting", async () => {
    const first = transportFixture();
    const second = transportFixture();
    const prepareError = new Error("bridge recovery denied");
    let prepareCount = 0;
    const h = harness({
      transports: [first, second],
      prepare: vi.fn(async () => {
        prepareCount += 1;
        if (prepareCount === 2) throw prepareError;
      }),
    });
    h.lifecycle.start();
    await flush();
    first.emit(snapshotFrame(first.subscriptionId, snapshot("old visible")), "initial");
    await flush();
    const oldSnapshot = h.lifecycle.store?.getState().snapshot;

    h.lifecycle.recoverBridge();
    await flush();

    expect(h.states.at(-1)).toMatchObject({
      status: "error",
      snapshot: oldSnapshot,
      lastError: "bridge recovery denied",
    });
    expect(h.onError).toHaveBeenCalledWith(prepareError);
    expect(second.transport.subscribe).not.toHaveBeenCalled();
    h.lifecycle.dispose();
    await flush();
  });

  it("surfaces an initial subscription failure as an error instead of a live empty session", async () => {
    const failed = transportFixture({ subscribeError: new Error("initial denied") });
    const h = harness({ transports: [failed] });
    h.lifecycle.start();
    await flush();

    expect(h.states.at(-1)).toMatchObject({ status: "error", snapshot: null });
    expect(h.onError).toHaveBeenCalledTimes(1);
    expect(h.onError).toHaveBeenCalledWith(expect.objectContaining({ message: "initial denied" }));
    expect(h.lifecycle.ready).toBe(false);
    h.lifecycle.dispose();
    await flush();
  });

  it("ignores an open result that arrives after its generation has been replaced", async () => {
    const lateTransport = transportFixture();
    const currentTransport = transportFixture();
    const lateOpen = deferred<ConversationTransport>();
    const states: ConversationStoreState[] = [];
    let openCount = 0;
    const lifecycle = new TaskConversationLifecycle(scope, {
      prepare: async () => {},
      open: () =>
        openCount++ === 0 ? lateOpen.promise : Promise.resolve(currentTransport.transport),
      onState: (state) => states.push(state),
      onError: vi.fn(),
    });

    lifecycle.start();
    await flush();
    lifecycle.recoverBridge();
    await flush();
    const currentStore = lifecycle.store;
    lateOpen.resolve(lateTransport.transport);
    await flush();

    expect(lifecycle.store).toBe(currentStore);
    expect(lateTransport.transport.subscribe).not.toHaveBeenCalled();
    expect(currentTransport.transport.subscribe).toHaveBeenCalledTimes(1);
    currentTransport.emit(
      snapshotFrame(currentTransport.subscriptionId, snapshot("current projection")),
      "initial",
    );
    expect(states.at(-1)?.status).toBe("live");
    expect(lifecycle.ready).toBe(true);
    lifecycle.dispose();
    await flush();
  });
});
