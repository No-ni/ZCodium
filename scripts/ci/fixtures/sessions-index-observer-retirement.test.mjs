import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { createWindowHostSessionsIndexObserver } from "../../../packages/desktop/src/host/windowHostSessionsIndexObserver.ts";
import { V4_WIRE_PROTOCOL_VERSION } from "@zcode/shared/zcode-protocol-v4";

const workspaceKey = "/fixture";
const topic = `sessions-index/${workspaceKey}`;
const unavailable = Object.assign(new Error("fixture runtime unavailable"), {
  code: "ZCODE_AGENT_RUNTIME_UNAVAILABLE",
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fixture({ pendingSubscribe } = {}) {
  let onFrame, onLifecycle;
  let subscriptions = 0;
  const resync = deferred();
  const unsubscribed = [],
    errors = [],
    projections = [],
    policies = [];
  const observer = createWindowHostSessionsIndexObserver({
    target: { workspacePath: workspaceKey },
    onSessionsChange: (sessions) => projections.push(sessions),
    onError: (error) => errors.push(error),
    agentService: {
      onDynamicSessionsIndexFrame: () => (listener) => {
        onFrame = listener;
        return { dispose() {} };
      },
      onAgentRuntimeLifecycle(listener) {
        onLifecycle = listener;
        return { dispose() {} };
      },
      async subscribeSessionsIndexV4(params) {
        policies.push(params.runtimePolicy);
        subscriptions++;
        if (subscriptions === 1 && pendingSubscribe) return pendingSubscribe.promise;
        return { ack: { subscriptionId: `subscription-${subscriptions}` } };
      },
      resyncSessionsIndexV4(params) {
        policies.push(params.runtimePolicy);
        return resync.promise;
      },
      async unsubscribeSessionsIndexV4(params) {
        policies.push(params.runtimePolicy);
        unsubscribed.push(params.subscriptionId);
      },
    },
  });
  function emitFrame(subscriptionId, ordinal, payload, fromSeq, toSeq) {
    onFrame({
      wireVersion: V4_WIRE_PROTOCOL_VERSION,
      kind: "complete",
      deliveryKind: ordinal === 1 ? "initial" : "online",
      logicalFrameId: `${subscriptionId}-${ordinal}`,
      logicalFrameOrdinal: ordinal,
      topic,
      subscriptionId,
      frame: { topic, subscriptionId, fromSeq, toSeq, sentAt: 1, payload },
    });
  }
  return {
    observer,
    resync,
    errors,
    unsubscribed,
    projections,
    policies,
    subscriptions: () => subscriptions,
    lifecycle(state) {
      onLifecycle({ workspaceKey, state });
    },
    snapshot(subscriptionId) {
      emitFrame(
        subscriptionId,
        1,
        {
          kind: "snapshot",
          snapshot: {
            protocolVersion: 1,
            workspaceId: workspaceKey,
            logEpoch: subscriptionId,
            sessions: [],
          },
        },
        0,
        1,
      );
    },
    gap() {
      emitFrame("subscription-1", 2, { kind: "deltas", deltas: [] }, 99, 100);
    },
  };
}

test("late resync rejection cannot unsubscribe the next runtime generation", async () => {
  const context = fixture();
  try {
    await context.observer.start();
    context.snapshot("subscription-1");
    context.gap();
    context.lifecycle("unavailable");
    context.lifecycle("available");
    await nextTurn();
    context.snapshot("subscription-2");
    context.resync.reject(new Error("fixture retired resync"));
    await nextTurn();
    assert.equal(context.subscriptions(), 2);
    assert.deepEqual(context.unsubscribed, []);
    assert.deepEqual(context.errors, []);
    assert.ok(context.policies.every((policy) => policy === "existing-only"));
  } finally {
    context.observer.dispose();
  }
});

test("late resync rejection after disposal has no observer side effects", async () => {
  const context = fixture();
  await context.observer.start();
  context.snapshot("subscription-1");
  context.gap();
  context.observer.dispose();
  context.resync.reject(new Error("fixture disposed resync"));
  await nextTurn();
  assert.equal(context.subscriptions(), 1);
  assert.deepEqual(context.unsubscribed, ["subscription-1"]);
  assert.deepEqual(context.errors, []);
});

test("current resync rejection keeps the existing-only retry path", async () => {
  const context = fixture();
  try {
    await context.observer.start();
    context.snapshot("subscription-1");
    context.gap();
    const failure = new Error("fixture current resync");
    context.resync.reject(failure);
    await nextTurn();
    assert.equal(context.subscriptions(), 2);
    assert.deepEqual(context.unsubscribed, ["subscription-1"]);
    assert.deepEqual(context.errors, [failure]);
    assert.ok(context.policies.every((policy) => policy === "existing-only"));
  } finally {
    context.observer.dispose();
  }
});

test("retired subscribe failure cannot make an available runtime dormant", async () => {
  const pendingSubscribe = deferred();
  const context = fixture({ pendingSubscribe });
  try {
    const starting = context.observer.start();
    await nextTurn();
    context.lifecycle("unavailable");
    context.lifecycle("available");
    pendingSubscribe.reject(unavailable);
    await starting;
    await nextTurn();
    assert.equal(context.subscriptions(), 2);
    assert.deepEqual(context.errors, []);
  } finally {
    context.observer.dispose();
  }
});

test("current unavailable subscribe waits for the existing runtime available event", async () => {
  const pendingSubscribe = deferred();
  const context = fixture({ pendingSubscribe });
  try {
    const starting = context.observer.start();
    await nextTurn();
    pendingSubscribe.reject(unavailable);
    await starting;
    await context.observer.start();
    assert.equal(context.subscriptions(), 1);
    context.lifecycle("available");
    await nextTurn();
    assert.equal(context.subscriptions(), 2);
    assert.deepEqual(context.errors, []);
  } finally {
    context.observer.dispose();
  }
});
