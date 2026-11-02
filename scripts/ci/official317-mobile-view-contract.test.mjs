import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { z } from "zod";

async function load(path, dependencies = {}) {
  let text = await readFile(new URL("../../" + path, import.meta.url), "utf8");
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  for (const node of [...source.statements].reverse())
    if (ts.isImportDeclaration(node))
      text = text.slice(0, node.getFullStart()) + text.slice(node.end);
  const { outputText } = ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
  });
  const exports = {};
  new Function("exports", ...Object.keys(dependencies), outputText)(
    exports,
    ...Object.values(dependencies),
  );
  return exports;
}
const wire = await load("packages/shared/src/webRemoteControl/envelope.ts", {
  z,
  webRemoteControlRpcFrameEnvelopeSchema: z.object({ zcode_type: z.literal("rpc-frame") }),
  webRemoteControlRpcFrameAckEnvelopeSchema: z.object({ zcode_type: z.literal("rpc-frame-ack") }),
});
const router = await load("packages/desktop/src/main/webRemoteControl/payloadRouter.ts");
const runtimeExports = await load("packages/desktop/src/main/webRemoteControl/runtime.ts", {
  statusQrUrl: () => undefined,
});
const state = await load("packages/desktop/src/main/webRemoteControl/transportState.ts", {
  buildStatusSnapshot: runtimeExports.buildStatusSnapshot,
  clearPendingOutbound() {},
});
function fixture() {
  const runtime = {
    windowId: 1,
    workspacePath: "cwd",
    mobileConnected: true,
    status: "active",
    mobileTaskViewEpoch: "epoch-a",
    mobileTaskViewSeq: -1,
    workspaces: [
      {
        workspaceKey: "identity-a",
        workspacePath: "cwd",
        workspaceIdentity: "identity-a",
        remoteSessionId: "remote-a",
        kind: "remote",
      },
    ],
    tasks: [{ workspaceKey: "identity-a", taskId: "task-a" }],
    bridge: {
      bridgeSessionId: "bridge-a",
      bridgeGeneration: 2,
      workspaceKey: "identity-a",
      degraded: false,
      dispose() {},
    },
  };
  const statuses = [];
  const ctx = {
    runtime,
    deps: { logger: { debug() {}, info() {}, warn() {} } },
    emitStatus: () => statuses.push(runtimeExports.buildStatusSnapshot(runtime)),
  };
  const payload = {
    zcode_type: "mobile-task-view-update",
    epoch: "epoch-a",
    seq: 0,
    bridgeSessionId: "bridge-a",
    bridgeGeneration: 2,
    view: { workspacePath: "cwd", workspaceIdentity: "identity-a", taskId: "task-a" },
  };
  return { runtime, statuses, ctx, payload };
}
test("actual wire schema accepts view reports and rejects routes, unknown fields and invalid counters", () => {
  const { payload } = fixture();
  assert.equal(wire.webRemoteControlAppPayloadSchema.safeParse(payload).success, true);
  assert.equal(
    wire.webRemoteControlAppPayloadSchema.safeParse({ ...payload, view: null }).success,
    true,
  );
  for (const invalid of [
    { ...payload, seq: -1 },
    { ...payload, epoch: "" },
    { ...payload, extra: 1 },
    { ...payload, view: { ...payload.view, remoteSessionId: "injected" } },
  ])
    assert.equal(wire.webRemoteControlAppPayloadSchema.safeParse(invalid).success, false);
});
test("Main publishes only the current visible task and derives remote routing from its bridge target", async () => {
  const f = fixture();
  await router.routeMobilePayload(f.payload, f.ctx);
  assert.deepEqual(f.runtime.mobileTaskView, { ...f.payload.view, remoteSessionId: "remote-a" });
  assert.equal(f.statuses.length, 1);
  await router.routeMobilePayload({ ...f.payload, seq: 1, view: null }, f.ctx);
  assert.equal(f.runtime.mobileTaskView, undefined);
});
test("old epochs, duplicate seq, swapped bridges and wrong identities cannot manufacture viewing", async () => {
  for (const patch of [
    { epoch: "old" },
    { bridgeSessionId: "old" },
    { bridgeGeneration: 1 },
    { view: { workspacePath: "cwd", workspaceIdentity: "identity-b", taskId: "task-a" } },
    { view: { workspacePath: "cwd", workspaceIdentity: "identity-a", taskId: "task-b" } },
  ]) {
    const f = fixture();
    await router.routeMobilePayload({ ...f.payload, ...patch }, f.ctx);
    assert.equal(f.runtime.mobileTaskView, undefined);
  }
  const f = fixture();
  await router.routeMobilePayload(f.payload, f.ctx);
  await router.routeMobilePayload({ ...f.payload, view: null }, f.ctx);
  assert.ok(f.runtime.mobileTaskView);
});
test("disconnect revokes viewing immediately while preserving navigation memory", () => {
  const f = fixture();
  f.runtime.mobileTaskView = { ...f.payload.view };
  f.runtime.mobileViewState = { activeWorkspaceKey: "identity-a", activeTaskId: "task-a" };
  state.mapTransportState(
    f.runtime,
    "connecting",
    () => {},
    () => {},
  );
  assert.equal(f.runtime.mobileTaskView, undefined);
  assert.equal(f.runtime.mobileTaskViewEpoch, undefined);
  assert.equal(f.runtime.mobileViewState.activeTaskId, "task-a");
});

test("the actual client reports only its current bridge with increasing seq and live page visibility", async () => {
  const doc = { visibilityState: "visible" };
  const clientExports = await load("packages/web/src/mobile/protocol.ts", { document: doc });
  const client = Object.create(clientExports.MobileRemoteControlClient.prototype);
  const f = fixture();
  const sent = [];
  Object.assign(client, {
    state: "paired",
    mobileTaskViewEpoch: "epoch-a",
    mobileTaskViewSeq: 0,
    readyViewBridge: {
      bridgeSessionId: "bridge-a",
      bridgeGeneration: 2,
      workspacePath: "cwd",
      workspaceIdentity: "identity-a",
    },
    sendPayload: (p) => sent.push(p),
  });
  client.updateMobileTaskView(f.payload.view);
  doc.visibilityState = "hidden";
  client.updateMobileTaskView(f.payload.view);
  assert.deepEqual(
    sent.map((p) => [p.seq, p.view]),
    [
      [0, f.payload.view],
      [1, null],
    ],
  );
  doc.visibilityState = "visible";
  client.updateMobileTaskView({ ...f.payload.view, workspaceIdentity: "identity-b" });
  assert.equal(sent.length, 2);
  client.readyViewBridge = null;
  client.updateMobileTaskView(f.payload.view);
  assert.equal(sent.length, 2);
});

test("MobileApp uses its real display effect to revoke visibility on hide, freeze and cleanup", async () => {
  const text = await readFile(
    new URL("../../packages/web/src/mobile/MobileApp.tsx", import.meta.url),
    "utf8",
  );
  const source = ts.createSourceFile(
    "mobile.tsx",
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let callback;
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === "useEffect" &&
      node.arguments[0]?.getText(source).includes("const syncVisibleTask")
    )
      callback = node.arguments[0];
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(callback);
  const { outputText } = ts.transpileModule("const effect = " + callback.getText(source) + ";", {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  });
  const events = new Map();
  const viewed = [],
    navigation = [];
  const doc = {
    visibilityState: "visible",
    addEventListener: (name, f) => events.set(name, f),
    removeEventListener: (name) => events.delete(name),
  };
  const deps = {
    clientRef: {
      current: {
        updateMobileTaskView: (v) => viewed.push(v),
        sendPayload: (v) => navigation.push(v),
      },
    },
    document: doc,
    window: doc,
    connection: "paired",
    hasDisplayedConversation: true,
    selectedTaskId: "task-a",
    selectedWorkspaceKey: "identity-a",
    selectedWorkspacePath: "cwd",
    selectedWorkspaceIdentity: "identity-a",
  };
  const effect = new Function(...Object.keys(deps), outputText + "\nreturn effect;")(
    ...Object.values(deps),
  );
  const cleanup = effect();
  assert.equal(viewed[0].taskId, "task-a");
  assert.equal(navigation[0].viewState.activeTaskId, "task-a");
  doc.visibilityState = "hidden";
  events.get("visibilitychange")();
  assert.equal(viewed.at(-1), null);
  doc.visibilityState = "visible";
  events.get("resume")();
  assert.equal(viewed.at(-1).taskId, "task-a");
  events.get("freeze")();
  assert.equal(viewed.at(-1), null);
  cleanup();
  assert.equal(events.size, 0);
  assert.equal(viewed.at(-1), null);
});
