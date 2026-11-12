import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import React, { act, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import ts from "typescript";
import { loadComponentCallback } from "./component-callback.mjs";

const appPath = "packages/ui/src/App.tsx";
const layoutPath = "packages/ui/src/app-shell/WorkspaceShellLayout.tsx";
const mobilePath = "packages/ui/src/WebRemoteControlMobileShell.tsx";
const reporterPath = "packages/ui/src/web-remote-control/WebRemoteControlTaskViewReporter.tsx";

async function source(path) {
  const text = await readFile(new URL("../../../" + path, import.meta.url), "utf8");
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function one(root, predicate) {
  const matches = [];
  function visit(node) {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(root);
  assert.equal(matches.length, 1, "expected exactly one current production caller");
  return matches[0];
}

// 执行原参数绑定和原 JSX，不从预期字段列表合成 props；其余 UI 派生值只作为只读边界端口。
function compile(code, nodes, ports) {
  const names = new Set(["React", ...Object.keys(ports)]);
  function visit(node) {
    if (ts.isIdentifier(node) && /^[$A-Z_a-z][$\w]*$/.test(node.text)) names.add(node.text);
    ts.forEachChild(node, visit);
  }
  for (const node of nodes) visit(node);
  const keys = [...names];
  const { outputText } = ts.transpileModule(code, {
    fileName: "actual-caller.tsx",
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.React,
    },
  });
  return new Function(...keys, outputText + "\nreturn call;")(
    ...keys.map((key) =>
      key === "React" ? React : Object.hasOwn(ports, key) ? ports[key] : globalThis[key],
    ),
  );
}

export async function loadActualAppCaller(ports = {}) {
  const text = await source(appPath);
  const app = one(text, (node) => ts.isFunctionDeclaration(node) && node.name?.text === "App");
  const jsx = one(
    app,
    (node) =>
      ts.isJsxSelfClosingElement(node) && node.tagName.getText(text) === "WorkspaceShellLayout",
  );
  const binding = app.parameters[0].name;
  assert.ok(ts.isObjectBindingPattern(binding));
  return compile(
    "const call = (input) => { const " +
      binding.getText(text) +
      " = input; return " +
      jsx.getText(text) +
      "; };",
    [binding, jsx],
    {
      WorkspaceShellLayout: () => null,
      conversationFindState: { activeIndex: 0, navigationRequestId: 0, query: "" },
      fileChangeFindState: { activeIndex: 0, navigationRequestId: 0, query: "" },
      gitState: { summary: null },
      ...ports,
    },
  );
}

async function loadActualLayoutCaller(ports) {
  const text = await source(layoutPath);
  const component = one(
    text,
    (node) => ts.isFunctionExpression(node) && node.name?.text === "WorkspaceShellLayoutComponent",
  );
  const render = one(
    component,
    (node) => ts.isVariableDeclaration(node) && node.name.getText(text) === "renderRemoteShell",
  );
  const remote = one(
    component,
    (node) =>
      ts.isVariableDeclaration(node) && node.name.getText(text) === "isWebRemoteControlShell",
  );
  const query = one(
    text,
    (node) =>
      ts.isVariableDeclaration(node) &&
      node.name.getText(text) === "WEB_REMOTE_CONTROL_MOBILE_QUERY",
  );
  assert.ok(ts.isStringLiteral(query.initializer));
  const viewport = await loadComponentCallback(layoutPath, "getIsWebRemoteControlMobileViewport", {
    window: ports.window,
    WEB_REMOTE_CONTROL_MOBILE_QUERY: query.initializer.text,
  });
  const binding = component.parameters[0].name;
  return compile(
    "const call = (input) => { const " +
      binding.getText(text) +
      " = input; " +
      "const isWebRemoteControlShell = " +
      remote.initializer.getText(text) +
      "; " +
      "const isWebRemoteControlMobileViewport = viewport(); return (" +
      render.initializer.getText(text) +
      ")(wideContent); };",
    [binding, remote.initializer, render.initializer],
    { ...ports, viewport },
  );
}

async function loadActualMobileShell(ports) {
  const text = await source(mobilePath);
  const component = one(
    text,
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "WebRemoteControlMobileShell",
  );
  const history = await loadComponentCallback(
    mobilePath,
    "isWebRemoteControlMobileChatHistoryState",
    {},
  );
  const historyPorts = { window: ports.window, isWebRemoteControlMobileChatHistoryState: history };
  const push = await loadComponentCallback(
    mobilePath,
    "pushWebRemoteControlMobileChatHistory",
    historyPorts,
  );
  const resolve = await loadComponentCallback(
    mobilePath,
    "resolveInitialWebRemoteControlMobilePage",
    historyPorts,
  );
  return compile(
    "const call = " + component.getText(text).replace(/^export\s+/, "") + ";",
    [component],
    {
      ...ports,
      useCallback,
      useEffect,
      useState,
      pushWebRemoteControlMobileChatHistory: push,
      isWebRemoteControlMobileChatHistoryState: history,
      resolveInitialWebRemoteControlMobilePage: resolve,
    },
  );
}

export const workspace = "fixture-workspace";
export const identity = "fixture-identity";
export const taskId = "fixture-task";

export async function createShellFixture(width = 390) {
  const dom = new JSDOM("<div id='root'></div>", {
    pretendToBeVisual: true,
    url: "https://native-shell-fixture.invalid/",
  });
  const window = dom.window;
  Object.defineProperty(window, "innerWidth", { value: width, writable: true });
  window.matchMedia = (query) => ({
    media: query,
    matches: width <= Number(query.match(/max-width:\s*(\d+)px/)?.[1] ?? 0),
  });
  const globals = { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = Object.fromEntries(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const views = [];
  const navigation = [];
  const switcher = {
    updateMobileViewState: async (...values) => {
      navigation.push(values);
    },
    updateMobileTaskView: async (view) => {
      views.push(view);
    },
  };
  const state = {
    taskNavHistory: {
      cursor: 0,
      entries: [{ kind: "task", taskId, workspacePath: workspace, workspaceIdentity: identity }],
    },
    getWorkspaceState: () => ({ activeTaskId: taskId }),
  };
  const Reporter = await loadComponentCallback(reporterPath, "WebRemoteControlTaskViewReporter", {
    useEffect,
    useLayoutEffect,
    useRef,
    useZCodeSessionStore: (select) => select(state),
    logger: { warn() {} },
    document: window.document,
    window,
  });
  const Shell = await loadActualMobileShell({
    window,
    WebRemoteControlTaskViewReporter: Reporter,
    useZCodeIntl: () => ({ intl: { formatMessage: ({ id }) => id } }),
    useWebRemoteControlTerminalTransportState: (snapshot) => snapshot ?? "idle",
    Button: ({ children, onClick, type, "aria-label": label }) =>
      React.createElement("button", { onClick, type, "aria-label": label }, children),
    ArrowLeft: () => null,
    LoaderIcon: () => null,
    WebRemoteControlThemeMenu: () => null,
  });
  const app = await loadActualAppCaller({
    activeTaskId: taskId,
    workspaceIdentity: identity,
    workspaceMainView: "chat",
  });
  const layout = await loadActualLayoutCaller({
    window,
    WebRemoteControlMobileShell: Shell,
    ScopedErrorBoundary: ({ children }) => children,
    V4ChatPane: () => React.createElement("main", { "data-testid": "fixture-chat" }),
    renderWorkspaceSidebar: ({ navigateToChat }) =>
      React.createElement("button", {
        "data-testid": "fixture-open-task",
        onClick: navigateToChat,
      }),
    renderChatFindDialog: () => null,
    renderSidePanePanel: () => null,
    shouldRenderWorkspaceHeader: false,
    isWebRemoteControlTaskSwitching: false,
    gitState: { summary: null },
    wideContent: React.createElement("div", { "data-testid": "fixture-wide" }),
  });
  const root = createRoot(window.document.getElementById("root"));
  let currentInput;
  const defaults = {
    workspaceAbsPath: workspace,
    workspaceIdentity: identity,
    webRemoteControlWorkspaceSwitcher: switcher,
    webRemoteControlTerminalTransportState: "paired",
    isWorkspaceVisible: true,
  };
  return {
    window,
    document: window.document,
    views,
    navigation,
    switcher,
    state,
    async render(overrides = {}) {
      currentInput = { ...defaults, ...overrides };
      await act(async () => root.render(layout(app(currentInput).props)));
    },
    async update(overrides) {
      currentInput = { ...currentInput, ...overrides };
      await act(async () => root.render(layout(app(currentInput).props)));
    },
    async click(selector) {
      const element = window.document.querySelector(selector);
      assert.ok(element, "expected rendered actual Shell control");
      await act(async () =>
        element.dispatchEvent(new window.MouseEvent("click", { bubbles: true })),
      );
    },
    async hide() {
      Object.defineProperty(window.document, "visibilityState", {
        configurable: true,
        value: "hidden",
      });
      await act(async () => window.document.dispatchEvent(new window.Event("visibilitychange")));
    },
    async close() {
      try {
        await act(async () => root.unmount());
      } finally {
        dom.window.close();
        for (const [key, descriptor] of Object.entries(previous)) {
          if (descriptor) Object.defineProperty(globalThis, key, descriptor);
          else delete globalThis[key];
        }
      }
    },
  };
}
