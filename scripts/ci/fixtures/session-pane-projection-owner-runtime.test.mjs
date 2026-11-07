import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { assertProjectPath, projectRoot } from "../project-test-sandbox.mjs";

const sandbox = await assertProjectPath(process.env.PROJECT_TEST_SANDBOX_ROOT ?? "");
const [{ JSDOM }, { build, stop }] = await Promise.all([import("jsdom"), import("esbuild")]);
const dom = new JSDOM('<!doctype html><div id="root"></div>', {
  url: "http://pane-owner-fixture.invalid/",
});
const keys = ["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT"];
const previousGlobals = new Map(
  keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);
for (const key of keys) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : dom.window[key],
  });
}

// 回放真实 SessionPane 的 lease 读取与 binding 写入表达式，避免 fixture 自己补正确门禁。
const panePath = join(projectRoot, "packages/ui/src/v4/SessionPane.tsx");
const paneSource = await readFile(panePath, "utf8");
const ast = ts.createSourceFile(
  panePath,
  paneSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const calls = [];
function visit(node) {
  if (ts.isCallExpression(node)) calls.push(node);
  ts.forEachChild(node, visit);
}
visit(ast);
const leaseCalls = calls.filter(
  (node) => node.expression.getText(ast) === "resolvePaneSessionProjectionLease",
);
assert.equal(leaseCalls.length, 1);
const bindingCalls = calls.filter(
  (node) =>
    node.expression.getText(ast) === "setLeaseBinding" &&
    ts.isObjectLiteralExpression(node.arguments[0]),
);
assert.equal(bindingCalls.length, 1);
const fixturePath = await assertProjectPath(join(sandbox, "pane-owner.mjs"));
const { outputFiles } = await build({
  stdin: {
    contents: `
      import { resolvePaneSessionProjectionLease, useConversationProjection } from "./packages/ui/src/v4/useConversationProjection.ts";
      export { useConversationProjection };
      export function readPaneLease(leaseBinding, layer, draftRuntimeInvalidationVersion, sessionId) {
        return ${leaseCalls[0].getText(ast)};
      }
      export function createPaneBinding(nextLease, layer, draftRuntimeInvalidationVersion, sessionId) {
        return ${bindingCalls[0].arguments[0].getText(ast)};
      }
    `,
    resolveDir: projectRoot,
    loader: "ts",
  },
  outfile: fixturePath,
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  alias: { "@": join(projectRoot, "packages/ui/src") },
  external: ["react", "react/*"],
});
stop();
await writeFile(fixturePath, outputFiles[0].contents, { flag: "wx" });
const { readPaneLease, createPaneBinding, useConversationProjection } = await import(
  pathToFileURL(fixturePath).href
);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
let root;
let frames = [];

function createLease(sessionId, phase = "running") {
  let state = {
    status: "live",
    snapshot: {
      sessionId,
      control: { phase, canStop: phase === "running" },
      inputRouting: { mode: phase === "running" ? "enqueue" : "startNow" },
    },
  };
  const listeners = new Set();
  return {
    sessionId,
    store: {
      getState: () => state,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    publish(nextPhase) {
      state = {
        ...state,
        snapshot: {
          ...state.snapshot,
          control: { phase: nextPhase, canStop: nextPhase === "running" },
        },
      };
      for (const listener of listeners) listener();
    },
    listenerCount: () => listeners.size,
  };
}

function Probe({ binding, layer, sessionId, draftVersion = 1 }) {
  const lease = readPaneLease(binding, layer, draftVersion, sessionId);
  const state = useConversationProjection(lease);
  const snapshot = state.snapshot;
  const connecting = sessionId !== null && (state.status === "connecting" || snapshot === null);
  frames.push({ target: sessionId, snapshotId: snapshot?.sessionId ?? null, connecting });
  return createElement("div", {
    "data-projection": snapshot?.sessionId ?? "none",
    "data-busy": snapshot?.control.canStop ? "true" : "false",
    "data-routing": snapshot?.inputRouting.mode ?? "none",
    "data-connecting": String(connecting),
  });
}

async function render(props) {
  root ??= createRoot(document.getElementById("root"));
  await act(() => root.render(createElement(Probe, props)));
  return document.querySelector("[data-projection]").dataset;
}
afterEach(async () => {
  if (root) await act(() => root.unmount());
  root = null;
  frames = [];
});
after(() => {
  dom.window.close();
  for (const [key, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});

for (const [previousPhase, nextPhase] of [
  ["completedSuccess", "running"],
  ["running", "completedSuccess"],
]) {
  test(`正式会话切换 ${previousPhase} → ${nextPhase} 的首帧拒绝旧租约`, async () => {
    const layer = {};
    const previous = createLease("session-a", previousPhase);
    const next = createLease("session-b", nextPhase);
    const binding = createPaneBinding(previous, layer, 1, "session-a");
    await render({ binding, layer, sessionId: "session-a" });
    const switching = await render({ binding, layer, sessionId: "session-b" });
    assert.equal(switching.projection, "none");
    assert.equal(switching.connecting, "true");
    assert.equal(switching.routing, "none");
    assert.equal(previous.listenerCount(), 0);
    const acquired = await render({
      binding: createPaneBinding(next, layer, 1, "session-b"),
      layer,
      sessionId: "session-b",
    });
    assert.equal(acquired.projection, "session-b");
    assert.equal(acquired.busy, String(nextPhase === "running"));
    assert.ok(
      frames.every((frame) => frame.target !== "session-b" || frame.snapshotId !== "session-a"),
    );
  });
}

test("正式会话回到草稿时不沿用旧正式快照和停止状态", async () => {
  const layer = {};
  const previous = createLease("session-a");
  const binding = createPaneBinding(previous, layer, 1, "session-a");
  await render({ binding, layer, sessionId: "session-a" });
  const draft = await render({ binding, layer, sessionId: null });
  assert.equal(draft.projection, "none");
  assert.equal(draft.busy, "false");
  assert.equal(previous.listenerCount(), 0);
});

test("预热转正的实际 sessionId 相同，沿用同一投影而不产生连接空帧", async () => {
  const layer = {};
  const prewarm = createLease("prewarm-session");
  const binding = createPaneBinding(prewarm, layer, 1, null);
  await render({ binding, layer, sessionId: null });
  const promoted = await render({ binding, layer, sessionId: "prewarm-session" });
  assert.equal(promoted.projection, "prewarm-session");
  assert.equal(promoted.connecting, "false");
  assert.equal(prewarm.listenerCount(), 1);
});

test("相同 sessionId 跨 layer 以及旧草稿代均不能借用租约", async () => {
  const layer = {};
  const lease = createLease("same-id");
  const binding = createPaneBinding(lease, layer, 1, null);
  assert.equal((await render({ binding, layer: {}, sessionId: "same-id" })).projection, "none");
  assert.equal(
    (await render({ binding, layer, sessionId: null, draftVersion: 2 })).projection,
    "none",
  );
});

test("切换首帧之后旧 store 再更新，也不能把新会话变成旧会话的完成态", async () => {
  const layer = {};
  const previous = createLease("session-a");
  const binding = createPaneBinding(previous, layer, 1, "session-a");
  await render({ binding, layer, sessionId: "session-a" });
  await render({ binding, layer, sessionId: "session-b" });
  await act(() => previous.publish("completedSuccess"));
  assert.equal(document.querySelector("[data-projection]").dataset.projection, "none");
  assert.ok(frames.every((frame) => frame.target !== "session-b" || frame.snapshotId === null));
});
