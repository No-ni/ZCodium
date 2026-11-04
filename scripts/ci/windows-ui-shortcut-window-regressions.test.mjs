import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { loadComponentCallback } from "./fixtures/component-callback.mjs";

async function loadFunctions(path, ports, names) {
  const text = await readFile(path, "utf8");
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const statements = file.statements.filter((node) => !ts.isImportDeclaration(node));
  const body = statements
    .filter((node) => !names || (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)))
    .map((node) => node.getText(file).replace(/^export\s+/, ""))
    .join("\n");
  const { outputText } = ts.transpileModule(body, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  });
  return new Function(...Object.keys(ports), outputText + "\nreturn { " + ports.result + " }; ")(
    ...Object.values(ports),
  );
}
const shared = await loadFunctions("packages/shared/src/shortcutCommands.ts", {
  result:
    "SHORTCUT_COMMANDS, getDefaultShortcutBindings, parseShortcutBinding, serializeShortcutBinding",
});
const bindings = await loadFunctions(
  "packages/ui/src/shortcuts/bindings.ts",
  {
    ...shared,
    result: "resolveEffectiveShortcutBindings",
    logger: { warn() {} },
  },
  ["resolveEffectiveShortcutBindings"],
);

async function restore(overrides, apple = false) {
  const writes = [],
    toasts = [];
  const conflict = await loadFunctions("packages/ui/src/shortcuts/conflicts.ts", {
    ...shared,
    ...bindings,
    isAppleKeyboardPlatform: () => apple,
    result: "checkShortcutBindingConflict",
  });
  const callback = await loadComponentCallback(
    "packages/ui/src/settings/ShortcutSettingsSection.tsx",
    "clearBinding",
    {
      overrides,
      getDefaultShortcutBindings: shared.getDefaultShortcutBindings,
      ...conflict,
      isDesktop: true,
      intl: { formatMessage: (_, values) => values.command },
      commandLabel: (id) => id,
      toast: (message) => toasts.push(message),
      persistBindings: async (next) => writes.push(next),
    },
  );
  callback("openCommandCenter");
  return { writes, toasts };
}

test("WINUI17 restore refuses an occupied second default, including Windows physical aliases", async () => {
  for (const key of ["CmdOrCtrl+Shift+p", "Ctrl+Shift+p"]) {
    const overrides = { openCommandCenter: ["CmdOrCtrl+Shift+9"], toggleSidebar: [key] };
    const before = structuredClone(overrides);
    assert.deepEqual(await restore(overrides), { writes: [], toasts: ["toggleSidebar"] }, key);
    assert.deepEqual(overrides, before);
  }
});
test("WINUI17 first-default occupancy and an explicitly unassigned command are guarded", async () => {
  assert.deepEqual(await restore({ openCommandCenter: [], toggleSidebar: ["CmdOrCtrl+k"] }), {
    writes: [],
    toasts: ["toggleSidebar"],
  });
});
test("WINUI17 released defaults restore both keys without changing other overrides", async () => {
  const overrides = { openCommandCenter: ["CmdOrCtrl+Shift+9"], toggleSidebar: [] };
  const result = await restore(overrides);
  assert.deepEqual(result, { writes: [{ toggleSidebar: [] }], toasts: [] });
  assert.deepEqual(bindings.resolveEffectiveShortcutBindings(result.writes[0]).openCommandCenter, [
    "CmdOrCtrl+k",
    "CmdOrCtrl+Shift+p",
  ]);
});
test("WINUI17 default restoration preserves macOS Ctrl separation and scope isolation", async () => {
  for (const [overrides, apple] of [
    [{ openCommandCenter: [], toggleSidebar: ["Ctrl+Shift+p"] }, true],
    [{ openCommandCenter: [], composerSend: ["CmdOrCtrl+Shift+p"] }, false],
  ]) {
    const result = await restore(overrides, apple);
    assert.equal(result.writes.length, 1);
    assert.deepEqual(result.toasts, []);
  }
  assert.deepEqual(await restore(undefined), { writes: [], toasts: [] });
});

async function recordingEvent(key, options = {}) {
  let listener,
    inUpdater = false,
    state;
  const actions = [];
  const liveBindings = await loadFunctions("packages/ui/src/shortcuts/bindings.ts", {
    ...shared,
    isAppleKeyboardPlatform: () => false,
    logger: { warn() {} },
    result: "recordShortcutBinding",
  });
  const conflicts = await loadFunctions("packages/ui/src/shortcuts/conflicts.ts", {
    ...shared,
    ...bindings,
    isAppleKeyboardPlatform: () => false,
    result: "checkShortcutBindingConflict, isSamePhysicalBinding",
  });
  const current = {
    commandId: "toggleSidebar",
    mode: "replace",
    bindingIndex: 0,
    preview: null,
    error: null,
    conflictBinding: null,
    ...options.recording,
  };
  const effect = await loadFunctions("packages/ui/src/settings/useShortcutRecording.ts", {
    ...liveBindings,
    ...conflicts,
    result: "useShortcutRecording",
    useZCodeIntl: () => ({ intl: { formatMessage: ({ id }) => id } }),
    formatShortcutBindingLabel: (value) => value,
    useEffect: (callback) => callback(),
    window: {
      addEventListener: (_, callback) => {
        listener = callback;
      },
      removeEventListener() {},
    },
  });
  const action =
    (id) =>
    (...args) => {
      assert.equal(
        inUpdater,
        false,
        "Recording must not run side effects in a replayable React updater",
      );
      actions.push([id, ...args]);
    };
  effect.useShortcutRecording({
    recording: current,
    setRecording: (next) => {
      // 模拟严格模式在渲染期间重放 updater；真实动作只能在原 keydown 中发生。
      if (typeof next === "function") {
        inUpdater = true;
        next(current);
        state = next(current);
        inUpdater = false;
      } else state = next;
    },
    effective: bindings.resolveEffectiveShortcutBindings(),
    overrides: undefined,
    isDesktop: true,
    clearBinding: action("restore"),
    appendBinding: action("append"),
    replaceBindingAt: action("replace"),
  });
  listener({
    key,
    code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: true,
    preventDefault() {},
    stopPropagation() {},
    ...options.event,
  });
  return { state, actions };
}
test("WINUI19 restore, append and replace run once in the key event instead of the React updater", async () => {
  assert.deepEqual((await recordingEvent("Backspace")).actions, [["restore", "toggleSidebar"]]);
  for (const [recording, expected] of [
    [{}, ["replace", "toggleSidebar", 0, "CmdOrCtrl+Shift+y"]],
    [{ mode: "add", bindingIndex: null }, ["append", "toggleSidebar", "CmdOrCtrl+Shift+y"]],
  ]) {
    const result = await recordingEvent("y", { recording });
    assert.deepEqual(result.actions, [expected]);
    assert.equal(result.state, null);
  }
  // 录制的显式意图允许 IME 事件按物理 code 录制，匹配侧的噪声策略不套用到这里。
  assert.deepEqual((await recordingEvent("y", { event: { isComposing: true } })).actions, [
    ["replace", "toggleSidebar", 0, "CmdOrCtrl+Shift+y"],
  ]);
});
test("WINUI19 escape, noise, duplicate, invalid and occupied keys do not save", async () => {
  for (const [key, options] of [
    ["Escape", {}],
    ["y", { event: { repeat: true } }],
    ["y", { event: { isComposing: true, code: undefined } }],
    ["y", { event: { ctrlKey: false, shiftKey: false } }],
    ["b", { recording: { mode: "add" }, event: { shiftKey: false } }],
    ["p", {}],
  ])
    assert.deepEqual((await recordingEvent(key, options)).actions, []);
});

async function windowPorts() {
  const windows = new Map();
  const ports = await loadFunctions(
    "packages/desktop/src/main/desktopWindowLifecycle.ts",
    {
      BrowserWindow: { fromId: (id) => windows.get(id) },
      PlatformChannels: { FocusTab: "focus-tab" },
      result: "focusWorkspaceInExistingWindow, handleDesktopWindowCloseRequest",
    },
    ["focusWorkspaceInExistingWindow", "handleDesktopWindowCloseRequest"],
  );
  return { ...ports, windows };
}
function windowFixture({ visible = true, minimized = false, destroyed = false } = {}) {
  const calls = [];
  return {
    calls,
    isDestroyed: () => destroyed,
    isMinimized: () => minimized,
    isVisible: () => visible,
    restore: () => {
      calls.push("restore");
      minimized = false;
    },
    show: () => {
      calls.push("show");
      visible = true;
    },
    hide: () => {
      calls.push("hide");
      visible = false;
    },
    focus: () => calls.push("focus"),
    webContents: { send: (...args) => calls.push(args) },
  };
}
test("WINUI18 reopening a workspace shows its original window after Windows close to tray", async () => {
  const { windows, focusWorkspaceInExistingWindow, handleDesktopWindowCloseRequest } =
    await windowPorts();
  const win = windowFixture();
  windows.set(1, win);
  const workspaceMap = new Map([
    [1, new Set(["fixture-project"])],
    [2, new Set()],
  ]);
  assert.equal(
    handleDesktopWindowCloseRequest({
      platform: "win32",
      closeToTrayOnWindows: true,
      forceQuit: false,
      isLastWindow: false,
      label: "fixture",
      logger: { info() {} },
      hideWindow: win.hide,
      confirmQuit: () => assert.fail("Unexpected quit confirmation"),
      requestQuit: () => assert.fail("Unexpected quit"),
    }),
    true,
  );
  assert.equal(win.isVisible(), false);
  assert.deepEqual(
    focusWorkspaceInExistingWindow("fixture-project", workspaceMap, { skipWindowId: 2 }),
    { activated: true, winId: 1 },
  );
  assert.equal(win.isVisible(), true, "activated response must correspond to a visible window");
  assert.deepEqual(win.calls, ["hide", "show", "focus", ["focus-tab", "fixture-project"]]);
  assert.equal(workspaceMap.size, 2);
});
test("WINUI18 visible/minimized windows retain restore, focus and tab ordering", async () => {
  for (const [options, expected] of [
    [{ visible: true }, ["focus"]],
    [{ visible: true, minimized: true }, ["restore", "focus"]],
    [{ visible: false, minimized: true }, ["restore", "show", "focus"]],
  ]) {
    const { windows, focusWorkspaceInExistingWindow } = await windowPorts();
    const win = windowFixture(options);
    windows.set(1, win);
    assert.equal(
      focusWorkspaceInExistingWindow(
        "fixture-project",
        new Map([[1, new Set(["fixture-project"])]]),
      ).activated,
      true,
    );
    assert.deepEqual(win.calls, [...expected, ["focus-tab", "fixture-project"]]);
  }
});
test("WINUI18 activation skips its sender, removes stale registrations and preserves unmatched fallback", async () => {
  const { windows, focusWorkspaceInExistingWindow } = await windowPorts();
  const sender = windowFixture({ visible: false }),
    target = windowFixture({ visible: false });
  windows.set(1, sender);
  windows.set(2, windowFixture({ destroyed: true }));
  windows.set(4, target);
  const map = new Map([1, 2, 3, 4].map((id) => [id, new Set(["fixture-project"])]));
  assert.deepEqual(focusWorkspaceInExistingWindow("fixture-project", map, { skipWindowId: 1 }), {
    activated: true,
    winId: 4,
  });
  assert.deepEqual(sender.calls, []);
  assert.deepEqual(target.calls, ["show", "focus", ["focus-tab", "fixture-project"]]);
  assert.deepEqual([...map.keys()], [1, 4]);
  assert.deepEqual(focusWorkspaceInExistingWindow("other-project", map), { activated: false });
});
