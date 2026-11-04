import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function sourceBody(path) {
  const text = await readFile(path, "utf8");
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  return ts.transpileModule(
    file.statements
      .filter((n) => !ts.isImportDeclaration(n))
      .map((n) => n.getText(file).replace(/^export\s+/, ""))
      .join("\n"),
    { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } },
  ).outputText;
}
const rootJs = await sourceBody("packages/ui/src/root/useRootPlatformEffects.ts");
const identityJs = await sourceBody("packages/shared/src/remote-workspace-identity.ts");
const { parse: parseIdentity, build: buildIdentity } = new Function(
  identityJs +
    "\nreturn {parse: parseRemoteWorkspaceIdentity, build: buildRemoteWorkspaceIdentity};",
)();
const workspaceTab = (tab) => tab.kind === "workspace";
const taskId = "E2E_NOTICE_TASK";
const path = "/fixture/project";
const identity = "remote:server:fixture-source:/fixture/project";
const tab = {
  id: "fixture-tab",
  kind: "workspace",
  workspacePath: path,
  workspaceIdentity: identity,
};

function fixture() {
  let effects = [],
    workspaces = {};
  const events = new Map(),
    calls = { activation: [], selection: [], opened: [], tasks: [], toasts: [], logs: [] };
  const platform = {};
  for (const event of [
    "onFocusTab",
    "onNewTab",
    "onNewTask",
    "onOpenWorkspace",
    "onOpenWorkspacePath",
    "onTaskNotificationClick",
    "onUpdateCheckResult",
  ]) {
    events.set(event, new Set());
    platform[event] = (handler) => {
      events.get(event).add(handler);
      return () => events.get(event).delete(handler);
    };
  }
  const logger = Object.fromEntries(
    ["info", "warn", "error"].map((level) => [level, (...args) => calls.logs.push(args)]),
  );
  const store = {
    getState: () => ({ workspaces, setActiveTaskId: (...args) => calls.selection.push(args) }),
  };
  const useHook = new Function(
    "useEffect",
    "useRef",
    "useZCodeSessionStore",
    "useTabStore",
    "isWorkspaceTab",
    "logger",
    "toast",
    "parseRemoteWorkspaceIdentity",
    "window",
    rootJs + "\nreturn useRootPlatformEffects;",
  )(
    (run, deps) => effects.push({ run, deps }),
    () => ({ current: undefined }),
    store,
    (selector) => selector({ tabs: [], activeTabId: "" }),
    workspaceTab,
    logger,
    (message) => calls.toasts.push(message),
    parseIdentity,
    { addEventListener() {}, removeEventListener() {} },
  );
  const noop = () => {};
  const props = {
    canBootstrapInitialWorkspace: false,
    platform,
    isDesktop: false,
    locale: "en-US",
    tabs: [],
    intl: { formatMessage: ({ id }) => "en:" + id },
    addTab: noop,
    setIsBootstrappingInitialWorkspace: noop,
    activateTabByPath: (...args) => calls.activation.push(args),
    startDraftInWorkspace: noop,
    startNewTaskFromActiveWorkspace: () => calls.tasks.push("old"),
    openWorkspace: noop,
    openWorkspacePath: (value) => calls.opened.push(["old", value]),
    setWorkspaceActionError: noop,
    allowOpenWorkspace: true,
  };
  function render(patch = {}) {
    Object.assign(props, patch);
    effects = [];
    useHook(props);
    return effects.find((effect) => effect.run.toString().includes("onTaskNotificationClick"));
  }
  let active, cleanup;
  function commit(patch = {}) {
    const next = render(patch);
    if (!active || next.deps.some((value, index) => !Object.is(value, active.deps[index]))) {
      cleanup?.();
      cleanup = next.run();
      active = next;
    }
    return () => {
      cleanup?.();
    };
  }
  return {
    calls,
    events,
    props,
    render,
    commit,
    setWorkspaces: (value) => {
      workspaces = value;
    },
    emit: (name, payload) => {
      for (const handler of events.get(name)) handler(payload);
    },
  };
}
function mount(run) {
  return run.render().run();
}

test("WINUI13 active remote task without cached metadata uses the matching tab path and identity", () => {
  const run = fixture();
  run.props.tabs = [tab];
  run.setWorkspaces({ [identity]: { activeTaskId: taskId } });
  const cleanup = mount(run);
  run.emit("onTaskNotificationClick", taskId);
  assert.deepEqual(run.calls.activation, [[path, { workspaceIdentity: identity }]]);
  assert.deepEqual(run.calls.selection, [[path, taskId, identity]]);
  cleanup();
});
test("WINUI13 a remote task with no tab uses the shared identity parser", () => {
  const run = fixture();
  run.setWorkspaces({ [identity]: { activeTaskId: taskId } });
  const cleanup = mount(run);
  run.emit("onTaskNotificationClick", taskId);
  assert.deepEqual(run.calls.selection, [[path, taskId, identity]]);
  cleanup();
});
for (const target of [
  { kind: "wsl", distro: "fixture-distro", user: "fixture-user" },
  { kind: "ssh", host: "fixture.invalid", port: 2222, username: "fixture-user" },
]) {
  test(`WINUI13 ${target.kind} notification restores path and identity without metadata or a tab`, () => {
    const run = fixture();
    const key = buildIdentity(path, target);
    run.setWorkspaces({ [key]: { activeTaskId: taskId } });
    const cleanup = mount(run);
    run.emit("onTaskNotificationClick", taskId);
    assert.deepEqual(run.calls.selection, [[path, taskId, key]]);
    cleanup();
  });
}
test("WINUI13 matching tab preserves an opaque identity and original directory", () => {
  const run = fixture();
  const key = "fixture-opaque-identity",
    originalPath = "C:/fixture/original";
  run.props.tabs = [{ ...tab, workspaceIdentity: key, workspacePath: originalPath }];
  run.setWorkspaces({ [key]: { activeTaskId: taskId } });
  const cleanup = mount(run);
  run.emit("onTaskNotificationClick", taskId);
  assert.deepEqual(run.calls.selection, [[originalPath, taskId, key]]);
  cleanup();
});
test("WINUI13 task metadata takes priority over the workspace tab", () => {
  const run = fixture();
  run.props.tabs = [tab];
  run.setWorkspaces({
    [identity]: {
      taskListCache: [
        { taskId, workspacePath: "/fixture/metadata", workspaceIdentity: "metadata-identity" },
      ],
    },
  });
  const cleanup = mount(run);
  run.emit("onTaskNotificationClick", taskId);
  assert.deepEqual(run.calls.selection, [["/fixture/metadata", taskId, "metadata-identity"]]);
  cleanup();
});
test("WINUI13 local fallback and unknown notification behavior remain intact", () => {
  const run = fixture();
  run.setWorkspaces({ [path]: { activeTaskId: taskId } });
  const cleanup = mount(run);
  run.emit("onTaskNotificationClick", "unknown");
  assert.deepEqual(run.calls.selection, []);
  run.emit("onTaskNotificationClick", taskId);
  assert.deepEqual(run.calls.selection, [[path, taskId, undefined]]);
  cleanup();
});
for (const field of [
  "intl",
  "allowOpenWorkspace",
  "openWorkspacePath",
  "startNewTaskFromActiveWorkspace",
]) {
  test(`WINUI14 native subscription tracks ${field} changes without a tab change`, () => {
    const run = fixture();
    run.commit();
    const replacement =
      field === "intl"
        ? { formatMessage: ({ id }) => "zh:" + id }
        : field === "allowOpenWorkspace"
          ? false
          : field === "openWorkspacePath"
            ? (value) => run.calls.opened.push(["new", value])
            : () => run.calls.tasks.push("new");
    const cleanup = run.commit({ [field]: replacement });
    if (field === "intl") {
      run.emit("onUpdateCheckResult", { kind: "dev-skipped" });
      assert.deepEqual(run.calls.toasts, ["zh:update.toast.devSkipped"]);
    } else if (field === "allowOpenWorkspace" || field === "openWorkspacePath") {
      run.emit("onOpenWorkspacePath", path);
      assert.deepEqual(run.calls.opened, field === "allowOpenWorkspace" ? [] : [["new", path]]);
    } else {
      run.emit("onNewTask");
      assert.deepEqual(run.calls.tasks, ["new"]);
    }
    for (const handlers of run.events.values()) assert.equal(handlers.size, 1);
    cleanup();
  });
}
test("WINUI14 subscription cleanup releases each native listener exactly once", () => {
  const run = fixture();
  const cleanup = mount(run);
  for (const handlers of run.events.values()) assert.equal(handlers.size, 1);
  cleanup();
  for (const handlers of run.events.values()) assert.equal(handlers.size, 0);
});
test("WINUI13 native navigation logs contain no task ID, directory or identity", () => {
  const run = fixture();
  run.props.tabs = [tab];
  run.setWorkspaces({ [identity]: { activeTaskId: taskId } });
  const cleanup = mount(run);
  run.emit("onTaskNotificationClick", taskId);
  run.emit("onOpenWorkspacePath", path);
  const output = JSON.stringify(run.calls.logs);
  for (const privateValue of [taskId, path, identity])
    assert.equal(output.includes(privateValue), false);
  cleanup();
});
