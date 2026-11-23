import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import { JSDOM } from "jsdom";
import ts from "typescript";

const require = createRequire(new URL("../../packages/ui/package.json", import.meta.url));
const React = require("react");
const { createRoot } = require("react-dom/client");
const source = await readFile(
  new URL("../../packages/ui/src/remote-connection-flow/index.ts", import.meta.url),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
  },
}).outputText;
let state;
const calls = [];
const refs = {
  minimizedRef: { current: false },
  entryEpochRef: { current: 1 },
  activeRequestIdRef: { current: null },
};
const functions = {
  useRemoteConnectionFlowState: () => state,
  buildRemoteFlowFormSnapshot: () => ({}),
  buildRemoteFlowView: (context) => context,
  getRemoteWizardStepCopy: () => ({}),
  classifyRemoteConnectionError: () => ({ category: "other" }),
  runHandleSelectDirectory: async (context, path) =>
    calls.push({
      path,
      target: context.localWorkspacePath,
      epoch: context.entryEpochRef.current,
    }),
  runCloseDialog: (context) => calls.push({ closedTarget: context.localWorkspacePath }),
};
const unknown = new Proxy(function () {}, { get: () => unknown });
const modules = new Proxy(functions, { get: (target, key) => target[key] ?? unknown });
const module = { exports: {} };
new Function("require", "module", "exports", compiled)(
  (id) => (id === "react" ? React : modules),
  module,
  module.exports,
);

test("the actual Flow hook routes retained event callbacks through the current context", async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const previous = new Map(
    ["window", "document", "IS_REACT_ACT_ENVIRONMENT"].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom.window },
    document: { configurable: true, value: dom.window.document },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  const root = createRoot(dom.window.document.getElementById("root"));
  let flow;
  function Harness() {
    flow = module.exports.useRemoteConnectionFlow({});
    return null;
  }
  state = {
    ...refs,
    open: false,
    kind: "ssh",
    availableKinds: [],
    currentStep: "device",
    localWorkspacePath: "synthetic-a",
    pendingRemoteTarget: null,
    sourceManagementSnapshot: null,
  };
  try {
    await React.act(async () => root.render(React.createElement(Harness)));
    const first = flow.handleSelectDirectory;
    await first("selected-a");
    state = { ...state, localWorkspacePath: "synthetic-b" };
    refs.entryEpochRef.current = 2;
    await React.act(async () => root.render(React.createElement(Harness)));
    await first("selected-b");
    assert.deepEqual(calls, [
      { path: "selected-a", target: "synthetic-a", epoch: 1 },
      { path: "selected-b", target: "synthetic-b", epoch: 2 },
    ]);
    assert.equal(flow.handleSelectDirectory, first);
  } finally {
    await React.act(async () => root.unmount());
    dom.window.close();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});
