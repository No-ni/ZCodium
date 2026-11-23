import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import { JSDOM } from "jsdom";
import ts from "typescript";

const require = createRequire(new URL("../../packages/ui/package.json", import.meta.url));
const React = require("react");
const { createRoot } = require("react-dom/client");

async function productionHook(path, hook, marker, binding) {
  const text = await readFile(new URL(`../../${path}`, import.meta.url), "utf8");
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const matches = [];
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === hook &&
      (!binding ||
        (ts.isVariableDeclaration(node.parent) && node.parent.name.getText(source) === binding)) &&
      (Array.isArray(marker)
        ? marker.every((value) => node.getText(source).includes(value))
        : node.getText(source).includes(marker))
    )
      matches.push(node.getText(source));
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal(matches.length, 1);
  return matches[0];
}

async function withRoot(run) {
  const dom = new JSDOM('<div id="root"></div>');
  const names = ["window", "document", "ResizeObserver", "IS_REACT_ACT_ENVIRONMENT"];
  const previous = new Map(
    names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
  );
  for (const name of names)
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: name === "IS_REACT_ACT_ENVIRONMENT" ? true : dom.window[name],
    });
  const root = createRoot(dom.window.document.getElementById("root"));
  try {
    await run(root, dom.window.document);
  } finally {
    await React.act(async () => root.unmount());
    for (const name of names) {
      const descriptor = previous.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
    dom.window.close();
  }
}

async function memoHarness(path, marker, extras, hookName = "useMemo") {
  const hook = await productionHook(path, hookName, marker);
  const parsed = ts.createSourceFile(
    "memo.tsx",
    hook,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const names = [
    ...new Set(
      parsed.statements[0].expression.arguments[1].elements
        .map((node) => node.getText(parsed).split(".")[0])
        .concat(extras),
    ),
  ];
  const compiled = ts.transpileModule(
    `return function Harness({inputs, render}) {
    const {${names.join(",")}} = inputs;
    const value = ${hook};
    return render(value);
  };`,
    { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  return {
    component: new Function("React", "useMemo", "useCallback", compiled)(
      React,
      React.useMemo,
      React.useCallback,
    ),
    inputs: Object.fromEntries(names.map((name) => [name, undefined])),
  };
}

test("favicon events update the current workspace scope without replacing the browser guest", async () => {
  const hook = await productionHook(
    "packages/ui/src/browser-use/UnifiedBrowserView.tsx",
    "useCallback",
    "page-favicon-updated",
    "handleWebviewRef",
  );
  const compiled = ts.transpileModule(
    `return function Harness({inputs, expose}) {
    const {recentVisitsScopeKey, updateBrowserVisitMetadata, logWebviewTeardown} = inputs;
    const faviconListenerRef = React.useRef(null), onPageMetadataChangeRef = React.useRef(null);
    const activeCommittedUrlRef = React.useRef("https://synthetic.example/"), webviewTeardownProbeRef = React.useRef({hadWebview:false});
    const recentVisitsScopeKeyRef = React.useRef(recentVisitsScopeKey);
    recentVisitsScopeKeyRef.current = recentVisitsScopeKey;
    const setWebview = React.useCallback(() => {}, []);
    expose(${hook});
    return null;
  };`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const Harness = new Function("React", "useCallback", compiled)(React, React.useCallback);
  const writes = [],
    listeners = new Map();
  const node = {
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: (name) => listeners.delete(name),
  };
  const base = {
    updateBrowserVisitMetadata: (scope) => writes.push(scope),
    logWebviewTeardown: () => {},
  };
  let attach;
  await withRoot(async (root) => {
    const render = (scope) =>
      React.act(async () =>
        root.render(
          React.createElement(Harness, {
            inputs: { ...base, recentVisitsScopeKey: scope },
            expose: (value) => {
              attach = value;
            },
          }),
        ),
      );
    await render("workspace-A");
    attach(node);
    listeners.get("page-favicon-updated")({ favicons: ["first"] });
    const originalAttach = attach;
    await render("workspace-B");
    assert.equal(attach, originalAttach);
    listeners.get("page-favicon-updated")({ favicons: ["second"] });
    assert.deepEqual(writes, ["workspace-A", "workspace-B"]);
    attach(null);
    assert.equal(listeners.size, 0);
  });
});

test("new tasks read group placement from the current service owner after rerender", async () => {
  const { component, inputs } = await memoHarness(
    "packages/ui/src/root/useRootWorkspaceActions.ts",
    "remoteProjectOpener.current",
    [
      "remoteProjectOpener",
      "navigationSequence",
      "useZCodeSessionStore",
      "readProjectSidebarView",
      "services",
      "resolveNewTaskTargetFromRequest",
      "resolveWorkbenchNewTaskTarget",
      "useWorkbenchGroupStore",
      "usePaneLayoutStore",
      "setWorkspaceActionError",
      "logger",
      "toast",
    ],
    "useCallback",
  );
  const requests = [];
  Object.assign(inputs, {
    remoteProjectOpener: { current: null },
    navigationSequence: { current: 0 },
    activeWorkspacePath: "synthetic-workspace",
    activeWorkspaceIdentity: null,
    tabStoreApi: { getState: () => ({ activeTabId: "tab" }) },
    useZCodeSessionStore: {
      getState: () => ({
        getWorkspaceState: () => ({ activeTaskId: "task", draftFocusVersion: 0 }),
      }),
    },
    readProjectSidebarView: () => "grouped",
    resolveNewTaskTargetFromRequest: () => null,
    resolveWorkbenchNewTaskTarget: () => null,
    useWorkbenchGroupStore: { getState: () => ({}) },
    usePaneLayoutStore: { getState: () => ({}) },
    workbenchGroupClientMode: "web-remote-replayable",
    openMobileProjectDraft: async (request) => requests.push(request),
    setWorkspaceActionError: (error) => {
      throw Error(String(error));
    },
    logger: { error() {} },
    toast() {},
    intl: { formatMessage: ({ id }) => id },
  });
  const service = (groupId) => ({
    taskGroupService: {
      read: async () => ({
        members: [{ taskId: "task", workspaceKey: "synthetic-workspace", groupId }],
      }),
    },
  });
  let create;
  await withRoot(async (root) => {
    const render = (services) =>
      React.act(async () =>
        root.render(
          React.createElement(component, {
            inputs: { ...inputs, services },
            render: (value) => {
              create = value;
              return null;
            },
          }),
        ),
      );
    await render(service("group-A"));
    await create("synthetic");
    await render(service("group-B"));
    await create("synthetic");
    assert.deepEqual(
      requests.map((request) => request.taskGroupId),
      ["group-A", "group-B"],
    );
  });
});

test("dom-ready uses the current responsive mode after it changes on the mounted browser", async () => {
  const path = "packages/ui/src/browser-use/UnifiedBrowserView.tsx";
  const text = await readFile(new URL(`../../${path}`, import.meta.url), "utf8");
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let effect, handler;
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === "useEffect" &&
      node.getText(source).includes("const handleDomReady")
    )
      effect = node;
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "handleDomReady")
      handler = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(effect && handler);
  const deps = effect.arguments[1].getText(source);
  const names = [
    ...new Set(
      effect.arguments[1].elements
        .map((node) => node.getText(source).split(".")[0])
        .concat([
          "isResponsiveMode",
          "pendingUrlRef",
          "pendingGuestNavigationCompletionRef",
          "guestRecoveryInProgressRef",
          "setBrowserState",
          "displayBrowserUrl",
        ]),
    ),
  ];
  const compiled = ts.transpileModule(
    `return function Harness({inputs, expose}) {const {${names.join(",")}}=inputs; useEffect(()=>{expose.current=${handler.getText(source)};},${deps});return null;};`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const Harness = new Function("useEffect", compiled)(React.useEffect);
  const zooms = [],
    expose = {};
  const inputs = Object.fromEntries(names.map((name) => [name, undefined]));
  Object.assign(inputs, {
    webview: {},
    setGuestZoomFactor: (_guest, zoom) => zooms.push(zoom),
    reportBrowserGuest() {},
    syncBrowserState() {},
    pendingUrlRef: { current: null },
    guestRecoveryInProgressRef: { current: false },
  });
  await withRoot(async (root) => {
    const render = (isResponsiveMode) =>
      React.act(async () =>
        root.render(
          React.createElement(Harness, { inputs: { ...inputs, isResponsiveMode }, expose }),
        ),
      );
    await render(true);
    expose.current();
    assert.deepEqual(zooms, [1]);
    zooms.length = 0;
    await render(false);
    expose.current();
    assert.deepEqual(zooms, []);
  });
});

test("nested tool cards use the current workflow action and animation settings after rerender", async () => {
  const { component, inputs } = await memoHarness(
    "packages/ui/src/ToolCallBlocks.tsx",
    "childToolCalls.map",
    [
      "ToolCallBlock",
      "NESTED_TOOLCALL_CONTAINER_CLASS",
      "onOpenWorkflowRun",
      "disableSummaryContentAnimation",
      "animateDiffCountOnMount",
    ],
  );
  const clicks = [];
  Object.assign(inputs, {
    childToolCalls: [{ toolCall: { toolId: "nested" } }],
    depth: 0,
    NESTED_TOOLCALL_CONTAINER_CLASS: "nested",
    onOpenWorkflowRun: () => clicks.push("first"),
    disableSummaryContentAnimation: false,
    animateDiffCountOnMount: false,
    ToolCallBlock: ({
      onOpenWorkflowRun,
      disableSummaryContentAnimation,
      animateDiffCountOnMount,
    }) =>
      React.createElement(
        "button",
        {
          onClick: onOpenWorkflowRun,
          "data-disabled": String(disableSummaryContentAnimation),
          "data-animate": String(animateDiffCountOnMount),
        },
        "open workflow",
      ),
  });
  await withRoot(async (root, document) => {
    const render = (changes) =>
      React.act(async () =>
        root.render(
          React.createElement(component, {
            inputs: { ...inputs, ...changes },
            render: (value) => value,
          }),
        ),
      );
    await render({});
    document.querySelector("button").click();
    await render({
      onOpenWorkflowRun: () => clicks.push("second"),
      disableSummaryContentAnimation: true,
      animateDiffCountOnMount: true,
    });
    document.querySelector("button").click();
    assert.deepEqual(clicks, ["first", "second"]);
    assert.equal(document.querySelector("button").dataset.disabled, "true");
    assert.equal(document.querySelector("button").dataset.animate, "true");
  });
});

test("expanded edit summaries follow the current diff animation option", async () => {
  const { component, inputs } = await memoHarness(
    "packages/ui/src/ToolCallBlocks/renderers/edit.tsx",
    "<EditFileSummaryBlock",
    ["ToolCallBody", "ToolSnapshotFieldNotice", "EditFileSummaryBlock", "EditInlineDiffContent"],
    "useCallback",
  );
  Object.assign(inputs, {
    rawFileSummaries: [{ path: "synthetic.txt" }],
    hasMultipleFiles: true,
    toolCall: { toolId: "edit", snapshotRefs: [] },
    context: { animateDiffCountOnMount: false },
    ToolCallBody: () => null,
    ToolSnapshotFieldNotice: () => null,
    EditInlineDiffContent: () => null,
    EditFileSummaryBlock: ({ animateDiffCountOnMount }) =>
      React.createElement("output", { "data-animate": String(animateDiffCountOnMount) }),
  });
  await withRoot(async (root, document) => {
    const render = (animateDiffCountOnMount) =>
      React.act(async () =>
        root.render(
          React.createElement(component, {
            inputs: { ...inputs, context: { ...inputs.context, animateDiffCountOnMount } },
            render: (value) => value(),
          }),
        ),
      );
    await render(false);
    assert.equal(document.querySelector("output").dataset.animate, "false");
    await render(true);
    assert.equal(document.querySelector("output").dataset.animate, "true");
  });
});

test("source settings expose the existing device-name preference while the remote service is unavailable", async () => {
  const path = "packages/ui/src/settings/SourceServerSettingsSection.tsx";
  const text = await readFile(new URL("../../" + path, import.meta.url), "utf8");
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const node = source.statements.find(
    (entry) =>
      ts.isFunctionDeclaration(entry) && entry.name?.text === "SourceServerSettingsSection",
  );
  assert.ok(node);
  const calls = [];
  const state = {
    hideProjectDeviceNames: true,
    setHideProjectDeviceNames: (hidden) => calls.push(hidden),
  };
  const deps = {
    React,
    useRef: React.useRef,
    useState: React.useState,
    useEffect: React.useEffect,
    useZCodeIntl: () => ({ intl: { formatMessage: ({ id }) => id } }),
    useSourceServerManagement: () => ({
      state: { status: "unavailable" },
      refresh: async () => {},
    }),
    useZCodeStore: (select) => select(state),
    SettingsRow: ({ control }) => control,
    Switch: ({ checked, onCheckedChange, ...props }) =>
      React.createElement("button", {
        ...props,
        role: "switch",
        "aria-checked": checked,
        onClick: () => onCheckedChange(!checked),
      }),
    Button: ({ children }) => React.createElement("button", null, children),
  };
  const code = ts.transpileModule(
    node.getText(source).replace(/^export\s+/, "") + "\nreturn SourceServerSettingsSection;",
    { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } },
  ).outputText;
  const component = new Function(...Object.keys(deps), code)(...Object.values(deps));
  await withRoot(async (root, document) => {
    await React.act(async () => root.render(React.createElement(component)));
    const control = document.querySelector('[role="switch"]');
    assert.ok(control, "the existing local preference must remain editable");
    assert.equal(control.getAttribute("aria-checked"), "true");
    await React.act(async () => control.click());
    assert.deepEqual(calls, [false]);
  });
});

for (const renderer of ["execute-group", "changes-group", "explore"]) {
  test(`expanded ${renderer} cards follow a replaced nested renderer`, async () => {
    const { component, inputs } = await memoHarness(
      `packages/ui/src/ToolCallBlocks/renderers/${renderer}.tsx`,
      "<ToolCallBlock",
      ["ToolCallBlock"],
      "useCallback",
    );
    Object.assign(inputs, {
      childToolCalls: [{ toolCall: { toolId: "nested" } }],
      context: {},
      ToolCallBlock: () => React.createElement("output", null, "first"),
    });
    await withRoot(async (root, document) => {
      const render = (ToolCallBlock) =>
        React.act(async () =>
          root.render(
            React.createElement(component, {
              inputs: { ...inputs, ToolCallBlock },
              render: (value) => value(),
            }),
          ),
        );
      await render(inputs.ToolCallBlock);
      assert.equal(document.querySelector("output").textContent, "first");
      await render(() => React.createElement("output", null, "second"));
      assert.equal(document.querySelector("output").textContent, "second");
    });
  });
}

test("closing a reopened side pane exits the current owner's full view", async () => {
  const hook = await productionHook(
    "packages/ui/src/App.tsx",
    "useCallback",
    "handleToggleSidePaneCollapse",
    "handleToggleSidePane",
  );
  const compiled = ts.transpileModule(
    `return function Harness({isSidePaneOpen, sidePaneFullView, handleToggleSidePaneCollapse, capture}) {
    const exitSidePaneFullView = sidePaneFullView.exit;
    const callback = ${hook}; capture(callback); return null;
  };`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const Harness = new Function("useCallback", compiled)(React.useCallback);
  const calls = [];
  const handleToggleSidePaneCollapse = () => calls.push("toggle");
  let current;
  const capture = (callback) => {
    current = callback;
  };
  await withRoot(async (root) => {
    const render = (isSidePaneOpen, owner) =>
      React.act(async () =>
        root.render(
          React.createElement(Harness, {
            isSidePaneOpen,
            sidePaneFullView: { exit: () => calls.push(owner) },
            handleToggleSidePaneCollapse,
            capture,
          }),
        ),
      );
    await render(false, "first");
    current();
    await render(true, "second");
    current();
    assert.deepEqual(calls, ["toggle", "second", "toggle"]);
  });
});

test("split pane shell routing follows the active session while its primary session remains empty", async () => {
  const { component, inputs } = await memoHarness(
    "packages/ui/src/v4/V4WorkspaceChatArea.tsx",
    "activeSessionId: sessionId",
    ["sessionId"],
  );
  Object.assign(inputs, { primaryPaneSessionId: null, workspacePath: "/synthetic-workspace" });
  await withRoot(async (root, document) => {
    const render = (sessionId) =>
      React.act(async () =>
        root.render(
          React.createElement(component, {
            inputs: { ...inputs, sessionId },
            render: (shell) =>
              React.createElement(
                "output",
                {
                  "data-primary": String(shell.sessionId),
                },
                shell.activeSessionId,
              ),
          }),
        ),
      );
    await render("split-A");
    assert.equal(document.querySelector("output").textContent, "split-A");
    await render("split-B");
    assert.equal(document.querySelector("output").dataset.primary, "null");
    assert.equal(document.querySelector("output").textContent, "split-B");
  });
});

test("expanded agent cards follow the current nested renderer and automation action", async () => {
  const { component, inputs } = await memoHarness(
    "packages/ui/src/ToolCallBlocks/renderers/agent.tsx",
    "<AgentChildToolList",
    ["AgentChildToolList"],
    "useCallback",
  );
  const clicks = [];
  const initialContext = {
    nestedToolRenderer: () => React.createElement("output", null, "first"),
    onOpenAutomationsMain: () => clicks.push("first"),
  };
  Object.assign(inputs, {
    context: initialContext,
    childToolCalls: [],
    toolCall: { status: "completed" },
    AgentChildToolList: ({ nestedToolRenderer: Renderer, onOpenAutomationsMain }) =>
      React.createElement(
        "button",
        { onClick: onOpenAutomationsMain },
        React.createElement(Renderer),
      ),
  });
  await withRoot(async (root, document) => {
    const render = (context) =>
      React.act(async () =>
        root.render(
          React.createElement(component, {
            inputs: { ...inputs, context },
            render: (callback) => callback(),
          }),
        ),
      );
    await render(initialContext);
    document.querySelector("button").click();
    await render({
      ...initialContext,
      nestedToolRenderer: () => React.createElement("output", null, "second"),
      onOpenAutomationsMain: () => clicks.push("second"),
    });
    document.querySelector("button").click();
    assert.equal(document.querySelector("output").textContent, "second");
    assert.deepEqual(clicks, ["first", "second"]);
  });
});

test("runtime preferences initialize when empty settings finish loading without resyncing unrelated settings", async () => {
  const hook = await productionHook(
    "packages/ui/src/Root.tsx",
    "useEffect",
    "初始化运行时偏好失败",
  );
  const compiled = ts.transpileModule(
    `return function Harness({appSettings, services}) {
    const settingsReady = appSettings != null;
    const {askUserQuestionAutoResolutionEnabled, toolSearchMode, pluginAutoRecommendationEnabled} = appSettings ?? {};
    ${hook};
    return React.createElement("output", null, String(settingsReady));
  };`,
    { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const component = new Function("React", "useEffect", "logger", compiled)(React, React.useEffect, {
    warn: () => assert.fail("unexpected preferences failure"),
  });
  const calls = [];
  const service = (owner) => ({
    syncAppRuntimePreferences: async (preferences) => calls.push({ owner, preferences }),
  });
  const services = { zcodeAgentService: service("cli"), botsService: service("bots") };
  await withRoot(async (root) => {
    const render = (appSettings) =>
      React.act(async () => root.render(React.createElement(component, { appSettings, services })));
    await render(null);
    assert.deepEqual(calls, []);
    await render({});
    assert.deepEqual(
      calls,
      ["cli", "bots"].map((owner) => ({
        owner,
        preferences: {
          askUserQuestionAutoResolutionEnabled: true,
          toolSearchMode: "off",
          pluginAutoRecommendationEnabled: false,
        },
      })),
    );
    await render({ theme: "dark" });
    assert.equal(calls.length, 2);
    await render({ pluginAutoRecommendationEnabled: true });
    assert.equal(calls.length, 4);
    assert.equal(calls.at(-1).preferences.pluginAutoRecommendationEnabled, true);
  });
});

test("worktree branch labels follow locale changes on the mounted composer", async () => {
  const hook = await productionHook(
    "packages/ui/src/app-shell/WorkspaceShellLayout.tsx",
    "useMemo",
    "detachedLabel: intl.formatMessage",
  );
  const parsed = ts.createSourceFile(
    "memo.tsx",
    hook,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const names = [
    ...new Set(
      parsed.statements[0].expression.arguments[1].elements
        .map((node) => node.getText(parsed).split(".")[0])
        .concat("intl"),
    ),
  ];
  const compiled = ts.transpileModule(
    `return function Harness({ inputs }) {
    const { ${names.join(",")} } = inputs;
    return ${hook};
  };`,
    { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const components = {
    ProjectComposerMenu: ({ children }) => children,
    WorkspacePluginPreview: () => null,
    GitBranchSwitcher: () => null,
    WorktreeToggle: () => null,
    WorktreeBranchPicker: ({ currentBranchLabel }) =>
      React.createElement("output", null, currentBranchLabel),
    resolveGitBranchTriggerLabel: ({ detachedLabel }) => detachedLabel,
  };
  const Harness = new Function("React", "useMemo", ...Object.keys(components), compiled)(
    React,
    React.useMemo,
    ...Object.values(components),
  );
  const inputs = Object.fromEntries(names.map((name) => [name, undefined]));
  Object.assign(inputs, {
    isOfficeMode: false,
    isWebRemoteControlShell: false,
    activeWorkspacePurpose: "project",
    draftWorktree: { ref: "HEAD" },
    draftProjectId: "synthetic-project",
    gitState: { summary: { headRefType: "detached", branchName: null } },
    draftWorktreeCallbacks: {},
    worktreeSupport: { visible: false, available: true },
  });
  await withRoot(async (root, document) => {
    const render = (locale) =>
      React.act(async () =>
        root.render(
          React.createElement(Harness, {
            inputs: { ...inputs, intl: { formatMessage: () => locale } },
          }),
        ),
      );
    await render("Detached HEAD");
    assert.equal(document.querySelector("output").textContent, "Detached HEAD");
    await render("游离 HEAD");
    assert.equal(document.querySelector("output").textContent, "游离 HEAD");
  });
});

test("shared code hints track each child callback without depending on unrelated child props", async () => {
  const path = "packages/ui/src/components/ai-elements/code-block-tooltip-scope.tsx";
  const text = await readFile(new URL(`../../${path}`, import.meta.url), "utf8");
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = source.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "CodeBlockControlHint",
  );
  assert.ok(declaration);
  const compiled = ts.transpileModule(
    `${declaration.getText(source).replace("export function", "function")}\nreturn CodeBlockControlHint;`,
    { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const context = React.createContext(null),
    calls = [],
    callbacks = [];
  const scope = Object.fromEntries(
    ["pointerEnter", "pointerLeave", "focus", "blur", "pointerDown", "keyDown", "detach"].map(
      (name) => [name, (...args) => calls.push({ name, args })],
    ),
  );
  let forwarded;
  const Harness = new Function(
    "React",
    "useContext",
    "useCallback",
    "useMemo",
    "CodeBlockTooltipScopeContext",
    "composeRefs",
    "cloneElement",
    "ControlHintTooltip",
    compiled,
  )(
    React,
    React.useContext,
    React.useCallback,
    React.useMemo,
    context,
    (...refs) =>
      (node) => {
        for (const ref of refs) if (typeof ref === "function") ref(node);
      },
    (child, props) => {
      forwarded = props;
      return React.cloneElement(child, props);
    },
    ({ children }) => children,
  );
  const callback = (label) => (event) => {
    callbacks.push(label);
    if (label === "prevent") event.preventDefault();
  };
  const names = [
    "onPointerEnter",
    "onPointerLeave",
    "onFocus",
    "onBlur",
    "onPointerDown",
    "onKeyDown",
  ];
  const childProps = Object.fromEntries(names.map((name) => [name, callback(name)]));
  await withRoot(async (root, document) => {
    const render = (props) =>
      React.act(async () =>
        root.render(
          React.createElement(
            context.Provider,
            { value: scope },
            React.createElement(Harness, {
              title: "Copy",
              children: React.createElement("button", props, "Copy"),
            }),
          ),
        ),
      );
    await render(childProps);
    const first = { ...forwarded };
    await render({ ...childProps, "data-unrelated": "changed" });
    for (const name of names) assert.equal(forwarded[name], first[name], name);
    const event = {
      currentTarget: document.querySelector("button"),
      pointerType: "mouse",
      key: "Escape",
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
    };
    for (const name of names) forwarded[name](event);
    assert.deepEqual(callbacks, names);
    assert.deepEqual(
      calls.map((call) => call.name),
      ["pointerEnter", "pointerLeave", "focus", "blur", "pointerDown", "keyDown"],
    );
    await render({ ...childProps, onPointerEnter: callback("prevent") });
    assert.notEqual(forwarded.onPointerEnter, first.onPointerEnter);
    const previous = calls.length;
    forwarded.onPointerEnter(event);
    assert.equal(callbacks.at(-1), "prevent");
    assert.equal(calls.length, previous);
  });
});

test("markdown link routing follows a replaced service owner with the same local file service", async () => {
  const hook = await productionHook(
    "packages/ui/src/app-shell/WorkspaceShellLayout.tsx",
    "useCallback",
    "resolveTaskExecutionWorkspaceServices",
    "handleOpenMarkdownFileLink",
  );
  const compiled = ts.transpileModule(
    `
return function Harness({ baseServices, services, onOpenCodeViewer }) {
  const workspaceReadOnlyReason = undefined, isWebRemoteControlShell = false;
  const findFileLinkOwnerWorkspace = React.useCallback(() => null, []);
  const handleOpenBrowserUrl = React.useCallback(() => {}, []);
  const openFileTreeRequest = React.useCallback(() => {}, []);
  const intl = React.useMemo(() => ({ formatMessage: () => "failure" }), []);
  const handleOpenCodeViewer = onOpenCodeViewer;
  const handler = ${hook};
  return React.createElement("button", { onClick: () => handler({ path: "synthetic-file.txt", workspaceIdentity: "remote-owner", workspaceRemoteSessionId: "remote-session" }) }, "Open");
};`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const routes = [];
  const Harness = new Function(
    "React",
    "useCallback",
    "resolveTaskExecutionWorkspaceServices",
    "REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE",
    "shouldOpenAssistantHtmlInBrowser",
    "getPathLeaf",
    "logger",
    "toast",
    "shouldFallbackWorkspacePathToCodeViewer",
    compiled,
  )(
    React,
    React.useCallback,
    ({ baseServices }) => baseServices.remoteView,
    "disconnected",
    () => false,
    () => "synthetic-file.txt",
    { warn() {} },
    () => {},
    () => false,
  );
  const localFileService = {
    async stat() {
      throw new Error("Remote target used local service");
    },
  };
  const remote = (id) => ({
    fileService: {
      async stat() {
        routes.push(id);
        return { type: "file" };
      },
    },
  });
  const services = { fileService: localFileService };
  const opened = [],
    onOpenCodeViewer = (target) => opened.push(target);
  await withRoot(async (root, document) => {
    const render = (remoteView) =>
      React.act(async () =>
        root.render(
          React.createElement(Harness, {
            baseServices: { fileService: localFileService, remoteView },
            services,
            onOpenCodeViewer,
          }),
        ),
      );
    await render(remote("first"));
    await React.act(async () => document.querySelector("button").click());
    await render(remote("second"));
    await React.act(async () => document.querySelector("button").click());
    assert.deepEqual(routes, ["first", "second"]);
    assert.equal(opened.length, 2);
    assert.equal(opened[1].workspaceIdentity, "remote-owner");
    assert.equal(opened[1].workspaceRemoteSessionId, "remote-session");
  });
});

test("sidebar resize cleanup retains its mounted nodes after React clears refs", async () => {
  const hook = await productionHook(
    "packages/ui/src/app-shell/WorkspaceShellLayout.tsx",
    "useEffect",
    ["return () =>", "setWorkspaceSidebarResizeActive", "workspaceSidebarPanelElementRef"],
  );
  const compiled = ts.transpileModule(
    `
return function Harness() {
  const workspaceSidebarPanelElementRef = React.useRef(null), workspaceShellRef = React.useRef(null);
  ${hook};
  return React.createElement("div", { ref: workspaceShellRef }, React.createElement("div", { ref: workspaceSidebarPanelElementRef, "data-panel": "true" }));
};`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const cleaned = [];
  const Harness = new Function("React", "useEffect", "setWorkspaceSidebarResizeActive", compiled)(
    React,
    React.useEffect,
    (state) => cleaned.push(state),
  );
  await withRoot(async (root, document) => {
    await React.act(async () => root.render(React.createElement(Harness)));
    const panel = document.querySelector("[data-panel]"),
      shell = panel.parentElement;
    await React.act(async () => root.render(null));
    assert.equal(cleaned.length, 1);
    assert.equal(cleaned[0].active, false);
    assert.equal(cleaned[0].panelElement, panel);
    assert.equal(cleaned[0].shellElement, shell);
  });
});

test("workflow settings and successor navigation follow a changed execution root", async () => {
  const path = "packages/ui/src/app-shell/useWorkflowRunPaneSettings.ts";
  const text = await readFile(new URL(`../../${path}`, import.meta.url), "utf8");
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const scopeHelper = source.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "workflowRunTabScope",
  );
  assert.ok(scopeHelper);
  const scope = await productionHook(path, "useMemo", "workflowRunTabScope");
  const host = await productionHook(path, "useMemo", "apply: (change)");
  const followEffect = await productionHook(path, "useEffect", "replaceRunId");
  const compiled = ts.transpileModule(
    `${scopeHelper.getText(source).replace("export function", "function")}
return function Harness({ tab, follow, onOpenWorkflowRun, capture }) {
  const sendCommand = React.useCallback(() => {}, []), sessionModel = undefined;
  const successorArrived = Boolean(follow), setFollow = React.useCallback(() => {}, []);
  const tabScope = ${scope};
  const host = ${host};
  capture(host);
  ${followEffect};
  return null;
};`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const Harness = new Function("React", "useMemo", "useEffect", "createCommandEnvelope", compiled)(
    React,
    React.useMemo,
    React.useEffect,
    (request) => request,
  );
  let current;
  const capture = (host) => {
      current = host;
    },
    opened = [];
  const onOpenWorkflowRun = (request) => opened.push(request);
  const tab = {
    workspacePath: "synthetic-workspace",
    workspaceIdentity: "scope",
    remoteSessionId: "remote",
    parentSessionId: "parent",
    runId: "run",
    fileReferenceRootPath: "root-a",
  };
  await withRoot(async (root) => {
    const render = (props) =>
      React.act(async () =>
        root.render(React.createElement(Harness, { capture, onOpenWorkflowRun, ...props })),
      );
    await render({ tab });
    assert.equal(current.fileReferenceRootPath, "root-a");
    await render({
      tab: { ...tab, fileReferenceRootPath: "root-b" },
      follow: { runId: "successor", toolCallId: "call" },
    });
    assert.equal(current.fileReferenceRootPath, "root-b");
    assert.equal(opened.length, 1);
    assert.equal(opened[0].fileReferenceRootPath, "root-b");
    assert.equal(opened[0].remoteSessionId, "remote");
    assert.equal(opened[0].replaceRunId, "run");
  });
});

test("PDF wheel accumulation survives a zoom action update and calls the current action", async () => {
  const path = "apps/zcode-cli/packages/office-runtime/ui/viewers/usePdfInteraction.ts";
  const effect = await productionHook(path, "useEffect", 'addEventListener("wheel"');
  const event = await productionHook(path, "useEffectEvent", "stepZoom");
  const compiled = ts.transpileModule(
    `return function Harness({ stepZoom }) {
    const scrollRef = React.useRef(null), zoomAnchor = React.useRef(null);
    const stepCurrentZoom = ${event};
    ${effect};
    return React.createElement('div', {ref: scrollRef});
  };`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const Harness = new Function("React", "useEffect", "useEffectEvent", compiled)(
    React,
    React.useEffect,
    React.useEffectEvent,
  );
  const calls = [];
  await withRoot(async (root, document) => {
    const render = (stepZoom) =>
      React.act(async () => root.render(React.createElement(Harness, { stepZoom })));
    const wheel = () =>
      document.querySelector("#root > div").dispatchEvent(
        new document.defaultView.WheelEvent("wheel", {
          ctrlKey: true,
          deltaY: -20,
          cancelable: true,
        }),
      );
    await render((direction) => calls.push(["a", direction]));
    wheel();
    assert.deepEqual(calls, []);
    await render((direction) => calls.push(["b", direction]));
    wheel();
    assert.deepEqual(calls, [["b", 1]]);
  });
});

test("plugin card width callbacks release the old observer before binding the new callback", async () => {
  const effect = await productionHook(
    "packages/ui/src/plugin-ui/components/PluginUiCard.tsx",
    "useLayoutEffect",
    "ResizeObserver",
  );
  const Harness = new Function(
    "React",
    "useLayoutEffect",
    `return function Harness({ onWidthChange }) {
    const containerRef = React.useRef(null);
    ${effect};
    return React.createElement('div', {ref: containerRef});
  };`,
  )(React, React.useLayoutEffect);
  const calls = [],
    active = new Set();
  await withRoot(async (root) => {
    globalThis.ResizeObserver = class {
      constructor(callback) {
        this.callback = callback;
        active.add(this);
      }
      observe() {}
      disconnect() {
        active.delete(this);
      }
    };
    const render = (onWidthChange) =>
      React.act(async () => root.render(React.createElement(Harness, { onWidthChange })));
    await render((width) => calls.push(["a", width]));
    assert.equal(active.size, 1);
    const previous = [...active][0];
    await render((width) => calls.push(["b", width]));
    assert.equal(active.size, 1);
    assert.equal(active.has(previous), false);
    [...active][0].callback([{ contentRect: { width: 240 } }]);
    assert.deepEqual(calls.at(-1), ["b", 240]);
    await render(undefined);
    assert.equal(active.size, 0);
  });
});

test("plugin side-pane feed updates its remote connection while tab identity stays stable", async () => {
  const hook = await productionHook(
    "packages/ui/src/plugin-ui/adapters/usePluginUiSidePaneModel.tsx",
    "useMemo",
    "sessionId: tab.parentSessionId",
    "feedScope",
  );
  const compiled = ts.transpileModule(
    `return function Harness({tab, capture}) { const scope = ${hook}; capture(scope); return null; };`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const Harness = new Function("useMemo", compiled)(React.useMemo);
  let current;
  const capture = (scope) => {
    current = scope;
  };
  const tab = {
    workspacePath: "synthetic",
    workspaceIdentity: "identity",
    parentSessionId: "session",
    remoteSessionId: "connection-a",
  };
  await withRoot(async (root) => {
    const render = (value) =>
      React.act(async () => root.render(React.createElement(Harness, { tab: value, capture })));
    await render(tab);
    assert.equal(current.remoteSessionId, "connection-a");
    await render({ ...tab, remoteSessionId: "connection-b" });
    assert.equal(current.remoteSessionId, "connection-b");
  });
});

test("project directory ordering responds to a changed sorting projection with stable order keys", async () => {
  const hook = await productionHook(
    "packages/ui/src/project-sidebar/ProjectDirectoryProvider.tsx",
    "useMemo",
    "sorted.filter",
  );
  const compiled = ts.transpileModule(
    `return function Harness({preferences, sortedProjects, capture}) { const {sort} = preferences; const projects = ${hook}; capture(projects); return null; };`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const Harness = new Function("useMemo", compiled)(React.useMemo);
  const sortedProjects = [{ id: "a" }, { id: "b" }],
    order = [];
  let current;
  const capture = (projects) => {
    current = projects.map((project) => project.id);
  };
  await withRoot(async (root) => {
    const render = (sort) =>
      React.act(async () =>
        root.render(
          React.createElement(Harness, { preferences: { order, sort }, sortedProjects, capture }),
        ),
      );
    await render((items) => items);
    assert.deepEqual(current, ["a", "b"]);
    await render((items) => [...items].reverse());
    assert.deepEqual(current, ["b", "a"]);
  });
});

test("Hook form preserves the current boolean shell setting when saving", async () => {
  const hook = await productionHook(
    "packages/ui/src/settings/HookForm.tsx",
    "useCallback",
    "hook?.shell",
    "handleSave",
  );
  const compiled = ts.transpileModule(
    `return function Harness({hook, capture, onSave}) {
    const args = '', asyncCommand = false, command = 'synthetic', customJson = '', event = 'PreToolUse';
    const intl = React.useMemo(() => ({formatMessage: () => 'error'}), []), matcher = '', shell = '', statusMessage = '', storageLevel = 'user', timeout = '10', type = 'shell';
    const setCustomError = React.useCallback(() => {}, []);
    const save = ${hook}; capture(save); return null;
  };`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const Harness = new Function("React", "useCallback", "parseHookTimeoutSeconds", compiled)(
    React,
    React.useCallback,
    () => ({ seconds: 10 }),
  );
  let save;
  const capture = (callback) => {
      save = callback;
    },
    saved = [];
  const onSave = (value) => saved.push(value);
  await withRoot(async (root) => {
    const render = (shell) =>
      React.act(async () =>
        root.render(
          React.createElement(Harness, { hook: { enabled: true, shell }, capture, onSave }),
        ),
      );
    await render(true);
    save();
    assert.equal(saved.at(-1).shell, true);
    await render(false);
    save();
    assert.equal(saved.at(-1).shell, undefined);
  });
});

test("image keyboard navigation uses the current index callback", async () => {
  const path = "packages/ui/src/components/ai-elements/image-preview-dialog.tsx";
  const effect = await productionHook(path, "useEffect", 'addEventListener("keydown"');
  const compiled = ts.transpileModule(
    `return function Harness({navigate}) {
    const activeIndex = 0, items = ['a', 'b'], open = true;
    const navigateWithKeyboard = React.useEffectEvent(navigate);
    ${effect}; return null;
  };`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const Harness = new Function("React", "useEffect", compiled)(React, React.useEffect),
    calls = [];
  await withRoot(async (root, document) => {
    const render = (navigate) =>
      React.act(async () => root.render(React.createElement(Harness, { navigate })));
    await render((direction) => calls.push(["a", direction]));
    await render((direction) => calls.push(["b", direction]));
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Element");
    Object.defineProperty(globalThis, "Element", {
      value: document.defaultView.Element,
      configurable: true,
    });
    try {
      document.defaultView.dispatchEvent(
        new document.defaultView.KeyboardEvent("keydown", { key: "ArrowRight" }),
      );
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "Element", descriptor);
      else delete globalThis.Element;
    }
    assert.deepEqual(calls, [["b", 1]]);
  });
});

test("tab overview refreshes newly added localized titles while the tab arrays stay stable", async () => {
  const path = "packages/ui/src/app-shell/SidePaneTabOverview.tsx";
  const text = await readFile(new URL(`../../${path}`, import.meta.url), "utf8");
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const component = source.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "SidePaneTabOverview",
  );
  assert.ok(component);
  const compiled = ts.transpileModule(
    component.getText(source).replace("export function", "function") +
      "\nreturn SidePaneTabOverview;",
    { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const controls = [
    "Button",
    "Command",
    "CommandEmpty",
    "CommandGroup",
    "CommandInput",
    "CommandItem",
    "CommandList",
    "Popover",
    "PopoverContent",
    "PopoverTrigger",
    "ChevronsDownIcon",
    "XIcon",
    "SidePaneTabIcon",
  ];
  const Harness = new Function(
    "React",
    "useEffect",
    "useMemo",
    "useState",
    "cn",
    "normalizeSearchQuery",
    "buildSearchFields",
    "filterAndRankSearchItems",
    "getLocalizedSidePaneTabTitle",
    "getSidePaneTabSearchHint",
    "getSidePaneTabTypeLabel",
    ...controls,
    compiled,
  )(
    React,
    React.useEffect,
    React.useMemo,
    React.useState,
    (...args) => args.filter(Boolean).join(" "),
    () => [],
    (...args) => args,
    (items) => items,
    (_tab, labels) => labels.workflowRunTitle,
    () => "",
    (_tab, labels) => labels.workflowRunTitle,
    ...controls.map(
      () =>
        ({ children }) =>
          React.createElement("div", null, children),
    ),
  );
  const tabs = [{ id: "run", type: "workflow-run", openedAt: 0 }],
    recentClosedTabs = [];
  const labels = { workflowRunTitle: "Run A", relativeTime: () => "now", closeTab: () => "close" };
  await withRoot(async (root, document) => {
    const render = (currentLabels) =>
      React.act(async () =>
        root.render(
          React.createElement(Harness, {
            tabs,
            recentClosedTabs,
            activeTabId: "run",
            labels: currentLabels,
            onActivateTab() {},
            onCloseTab() {},
            onReopenClosedTab() {},
          }),
        ),
      );
    await render(labels);
    assert.ok(document.body.textContent.includes("Run A"));
    await render({ ...labels, workflowRunTitle: "Run B" });
    assert.ok(document.body.textContent.includes("Run B"));
  });
});

test("conversation rows update runtime IO gates without replacing their snapshot", async () => {
  const hook = await productionHook(
    "packages/ui/src/v4/SessionPane.tsx",
    "useMemo",
    "fetchFileChanges: runtimeReady",
  );
  const compiled = ts.transpileModule(`const context = ${hook};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const generated = ts.createSourceFile(
    "generated.js",
    compiled,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const expression = generated.statements
    .find(ts.isVariableStatement)
    .declarationList.declarations[0].initializer.getText(generated);
  const source = ts.createSourceFile(
    "expression.js",
    expression,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const globals = new Set();
  function visit(node) {
    if (
      ts.isIdentifier(node) &&
      !["useMemo", "undefined", "runtimeReady"].includes(node.text) &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
      !(ts.isPropertyAssignment(node.parent) && node.parent.name === node)
    )
      globals.add(node.text);
    ts.forEachChild(node, visit);
  }
  visit(source);
  const names = [...globals];
  const values = {
    snapshot: { logEpoch: "fixture" },
    sessionId: "session",
    handleFetchFileChanges: async () => {},
    attachmentRead: async () => {},
    attachmentReadRange: async () => {},
    resolveWorkflowResumeHandler: () => undefined,
  };
  const Harness = new Function(
    "React",
    "useMemo",
    ...names,
    `return function Harness({runtimeReady}) { const context = ${expression}; return React.createElement('output', null, typeof context.fetchFileChanges + '/' + typeof context.readAttachment); };`,
  )(React, React.useMemo, ...names.map((name) => values[name]));
  await withRoot(async (root, document) => {
    const render = (runtimeReady) =>
      React.act(async () => root.render(React.createElement(Harness, { runtimeReady })));
    await render(false);
    assert.equal(document.querySelector("output").textContent, "undefined/undefined");
    await render(true);
    assert.equal(document.querySelector("output").textContent, "function/function");
    await render(false);
    assert.equal(document.querySelector("output").textContent, "undefined/undefined");
  });
});

test("file candidate presentation follows cwd when the candidate array stays stable", async () => {
  const hook = await productionHook(
    "packages/ui/src/mentions/MentionPlugin.tsx",
    "useMemo",
    "ContextMentionOptionContent",
  );
  const compiled = ts.transpileModule(
    `
return function Harness({ fileSearchRootPath, panelGroups, intl }) {
  const activeTrigger = {trigger: '@'}, workspacePath = 'synthetic-workspace';
  const sections = ${hook};
  return React.createElement('div', null, sections[0].options[0].content);
};`,
    { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const component = new Function("React", "useMemo", "ContextMentionOptionContent", compiled)(
    React,
    React.useMemo,
    ({ workspacePath }) => React.createElement("output", null, workspacePath),
  );
  await withRoot(async (root, document) => {
    const panelGroups = [
      { id: "files", items: [{ id: "file", label: "file", category: "files" }] },
    ];
    const intl = { formatMessage: ({ id }) => id };
    const render = (fileSearchRootPath) =>
      React.act(async () =>
        root.render(React.createElement(component, { fileSearchRootPath, panelGroups, intl })),
      );
    await render("synthetic-cwd-a");
    assert.equal(document.querySelector("output").textContent, "synthetic-cwd-a");
    await render("synthetic-cwd-b");
    assert.equal(document.querySelector("output").textContent, "synthetic-cwd-b");
  });
});

test("compact greeting releases measurement and restores it on the same component", async () => {
  const hook = await productionHook(
    "packages/ui/src/v4/ConversationDraftEmptyState.tsx",
    "useLayoutEffect",
    "compactForRemoteControl",
  );
  let measured = 0;
  const compiled = ts.transpileModule(
    `
return function Harness({ compactForRemoteControl }) {
  const greeting = 'synthetic greeting';
  const greetingContainerRef = React.useRef(null), greetingMeasurementRef = React.useRef(null);
  ${hook};
  return React.createElement('p', {ref: greetingContainerRef},
    React.createElement('span', null, React.createElement('span', {ref: greetingMeasurementRef}, greeting)));
};`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const component = new Function(
    "React",
    "useLayoutEffect",
    "resolveGreetingFontSizePx",
    "logger",
    compiled,
  )(
    React,
    React.useLayoutEffect,
    () => {
      measured++;
      return 30;
    },
    { debug() {} },
  );
  await withRoot(async (root) => {
    const active = new Set();
    globalThis.ResizeObserver = class {
      constructor() {
        active.add(this);
      }
      observe() {}
      disconnect() {
        active.delete(this);
      }
    };
    const render = (compactForRemoteControl) =>
      React.act(async () =>
        root.render(React.createElement(component, { compactForRemoteControl })),
      );
    await render(false);
    assert.equal(active.size, 1);
    await render(true);
    assert.equal(active.size, 0);
    await render(false);
    assert.equal(active.size, 1);
    assert.equal(measured, 2);
    await render(false);
    assert.equal(measured, 2);
    await React.act(async () => root.unmount());
    assert.equal(active.size, 0);
  });
});

test("composer controls reflect runtime blocking and mobile input changes", async () => {
  const hook = await productionHook(
    "packages/ui/src/v4/ConversationComposer.tsx",
    "useMemo",
    "remote-send-unavailable",
  );
  const parsed = ts.createSourceFile(
    "memo.tsx",
    hook,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const deps = parsed.statements[0].expression.arguments[1].elements.map((node) =>
    node.getText(parsed),
  );
  const names = [
    ...new Set([
      ...deps,
      "remoteAvailable",
      "runtimeBlocked",
      "isMobileTextInputViewport",
      "intl",
      "onSelectModel",
      "setSendTooltipOpen",
    ]),
  ];
  const compiled = ts.transpileModule(
    `
return function Harness({ inputs }) {
  const { ${names.join(",")} } = inputs;
  const TID_V4_STOP = 'stop', TID_V4_COMPOSER_SEND = 'send';
  return ${hook};
};`,
    { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const components = {
    ComposerStatusSlot: () => null,
    V4ComposerModelControls: ({ disabled, isMobileViewport }) =>
      React.createElement("output", {
        "data-testid": "model-controls",
        "data-disabled": String(disabled),
        "data-mobile": String(isMobileViewport),
      }),
    ControlHintTooltip: ({ children }) => children,
    Button: ({ children }) => React.createElement("button", null, children),
    SquareIcon: () => null,
    Spinner: () => null,
    ArrowUpIcon: () => null,
  };
  const component = new Function("React", "useMemo", ...Object.keys(components), compiled)(
    React,
    React.useMemo,
    ...Object.values(components),
  );
  await withRoot(async (root, document) => {
    const inputs = Object.fromEntries(names.map((name) => [name, undefined]));
    Object.assign(inputs, {
      remoteAvailable: true,
      runtimeBlocked: false,
      disabled: false,
      isMobileTextInputViewport: false,
      intl: { formatMessage: ({ id }) => id },
    });
    const render = (changes) =>
      React.act(async () =>
        root.render(React.createElement(component, { inputs: { ...inputs, ...changes } })),
      );
    await render({});
    assert.equal(document.querySelector("output").dataset.disabled, "false");
    await render({ runtimeBlocked: true });
    assert.equal(document.querySelector("output").dataset.disabled, "true");
    await render({ isMobileTextInputViewport: true });
    assert.equal(document.querySelector("output").dataset.mobile, "true");
    assert.equal(document.querySelector("output").dataset.disabled, "false");
  });
});
