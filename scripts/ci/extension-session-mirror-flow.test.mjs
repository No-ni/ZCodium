import assert from "node:assert/strict";
import { test } from "node:test";
import { createSessionMirrorFlow } from "../../packages/services/src/extensions/sessionMirrorFlow.ts";
import { SESSION_MIRROR_MAX_BYTES } from "@zcode/shared/extension-host";
import { assertProjectPath } from "./project-test-sandbox.mjs";

await assertProjectPath(process.env.PROJECT_TEST_SANDBOX_ROOT);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};
function harness() {
  const pending = deferred();
  const resync = deferred();
  const unsubscribed = [];
  const requests = [];
  const errors = [];
  const rows = [];
  const conversation = [];
  const interactions = [];
  let current = {
    gen: 1,
    ready: Promise.resolve(),
    scope: {
      service: {
        subscribeConversationV4: (target) => {
          requests.push(["subscribe", target]);
          return pending.promise;
        },
        resyncConversationV4: (target) => {
          requests.push(["resync", target]);
          return resync.promise;
        },
        unsubscribeConversationV4: async (target) => {
          unsubscribed.push(target);
        },
      },
    },
  };
  const mirror = {
    key: "identity\0session",
    target: { workspacePath: "fixture", workspaceIdentity: "identity", sessionId: "session" },
    topic: "fixture-topic",
    phase: "subscribing",
    attempt: 0,
    subscriptionId: null,
    assembler: {
      clear() {},
      abort() {},
      accept() {
        return [];
      },
    },
    snapshot: null,
    rowBytes: new Map(),
    totalBytes: 0,
    stateKey: null,
    interactionsKey: null,
    registrations: new Set(),
  };
  const registrations = new Set();
  for (const [kind, sink] of [
    ["rows", rows],
    ["conversation", conversation],
    ["interactions", interactions],
  ]) {
    const registration = {
      pluginId: "fixture",
      sessionId: "session",
      kind,
      disposed: false,
      mirror,
      listener: (event) => sink.push(event),
      fail: (error) => errors.push(error),
    };
    registrations.add(registration);
    mirror.registrations.add(registration);
  }
  const mirrors = new Map([[mirror.key, mirror]]);
  const logger = { info() {}, debug() {}, warn() {} };
  const flow = createSessionMirrorFlow(() => current, mirrors, registrations, logger);
  return {
    flow,
    mirror,
    mirrors,
    registrations,
    pending,
    resync,
    requests,
    unsubscribed,
    errors,
    rows,
    conversation,
    interactions,
    replace: (value) => {
      current = value;
    },
  };
}
const snapshot = (window = [{ rowId: 1, marker: "one" }]) => ({
  sessionId: "session",
  seq: 1,
  logEpoch: "epoch",
  revision: 1,
  rows: { window },
  control: { phase: "idle" },
  config: { mode: "default" },
  pendingInteractions: [],
});
const frame = (value) => ({
  subscriptionId: "sub",
  payload: { kind: "snapshot", snapshot: value },
});

test("late subscribe ACK releases its captured connection after replacement", async () => {
  const h = harness();
  h.flow.subscribe(h.mirror, "fixture");
  await flush();
  h.replace({ gen: 2 });
  h.pending.resolve({ ack: { subscriptionId: "old", mode: "snapshot" } });
  await flush();
  assert.equal(h.mirror.subscriptionId, null);
  assert.equal(h.unsubscribed.length, 1);
  assert.equal(h.unsubscribed[0].subscriptionId, "old");
  assert.equal(h.unsubscribed[0].workspaceIdentity, "identity");
});

test("closing a mirror invalidates in-flight ACK and releases one owner entry", async () => {
  const h = harness();
  h.flow.subscribe(h.mirror, "fixture");
  await flush();
  const attempt = h.mirror.attempt;
  h.flow.closeMirror(h.mirror, false);
  h.pending.resolve({ ack: { subscriptionId: "late", mode: "snapshot" } });
  await flush();
  assert.equal(h.mirror.phase, "closed");
  assert.equal(h.mirror.attempt, attempt + 1);
  assert.equal(h.mirrors.size, 0);
  assert.equal(h.unsubscribed.length, 1);
});

test("sequence gap requests one snapshot and stale failure cannot fail a closed mirror", async () => {
  const h = harness();
  h.flow.applyFrame(h.mirror, frame(snapshot()));
  const gap = {
    subscriptionId: "sub",
    fromSeq: 8,
    toSeq: 9,
    payload: { kind: "deltas", deltas: [] },
  };
  h.flow.applyFrame(h.mirror, gap);
  h.flow.applyFrame(h.mirror, gap);
  assert.equal(h.requests.filter(([kind]) => kind === "resync").length, 1);
  assert.equal(h.mirror.phase, "resyncing");
  assert.equal(h.requests[0][1].workspaceIdentity, "identity");
  h.flow.closeMirror(h.mirror, false);
  h.resync.reject(new Error("synthetic failure"));
  await flush();
  assert.deepEqual(h.errors, []);
});

test("byte budget trims oldest rows and oversized reset becomes stale", () => {
  const h = harness();
  const value = snapshot([
    { rowId: 1, marker: "x".repeat(SESSION_MIRROR_MAX_BYTES + 1) },
    { rowId: 2, marker: "keep" },
  ]);
  const limited = h.flow.fitBudget(h.mirror, value);
  assert.deepEqual(
    limited.rows.window.map((row) => row.rowId),
    [2],
  );
  h.flow.deliverRows(h.mirror, {
    kind: "reset",
    logEpoch: "epoch",
    revision: 1,
    rows: value.rows.window,
  });
  assert.deepEqual(h.rows, [{ kind: "stale", logEpoch: "epoch", revision: 1 }]);
});

test("state and allowed interactions publish once for equivalent snapshots", () => {
  const h = harness();
  const value = snapshot();
  value.pendingInteractions = [
    { kind: "permission", id: "tool" },
    { kind: "hookTrust", id: "private" },
  ];
  h.flow.publishState(h.mirror, value);
  h.flow.publishState(h.mirror, structuredClone(value));
  assert.equal(h.conversation.length, 1);
  assert.equal(h.interactions.length, 1);
  assert.deepEqual(
    h.interactions[0].interactions.map((item) => item.id),
    ["tool"],
  );
});
