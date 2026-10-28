import assert from "node:assert/strict";
import { test } from "node:test";
import { loadComponentCallback } from "./fixtures/component-callback.mjs";

const app = "packages/ui/src/App.tsx";
const host = "packages/ui/src/side-pane-full-view/components/ConversationHost.tsx";

test("full view opens the existing panel and admits exactly one controller command", async () => {
  const events = [];
  const toggle = await loadComponentCallback(app, "handleToggleSidePaneFullView", {
    isDesktop: true,
    isSidePaneOpen: false,
    setIsSidePaneCollapsed: (value) => events.push(["panel", value]),
    sidePaneFullView: {
      enter: () => events.push(["enter"]),
      toggle: () => events.push(["toggle"]),
    },
  });
  toggle();
  assert.deepEqual(events, [["panel", false], ["enter"]]);
});
test("web full view command does not open a panel or write preferences", async () => {
  const fail = () => assert.fail("Unsupported platform changed state");
  const toggle = await loadComponentCallback(app, "handleToggleSidePaneFullView", {
    isDesktop: false,
    isSidePaneOpen: false,
    setIsSidePaneCollapsed: fail,
    sidePaneFullView: { enter: fail, toggle: fail },
  });
  toggle();
});
test("closing the panel exits full view before changing the original preference", async () => {
  const events = [];
  const close = await loadComponentCallback(app, "handleToggleSidePane", {
    isSidePaneOpen: true,
    sidePaneFullView: { exit: () => events.push("exit") },
    handleToggleSidePaneCollapse: () => events.push("panel"),
  });
  close();
  assert.deepEqual(events, ["exit", "panel"]);
});
test("floating restore focuses the focused pane rather than an earlier hidden input", async () => {
  const events = [];
  const focusedInput = { focus: () => events.push("focused") };
  const hiddenInput = { focus: () => events.push("hidden") };
  const focusedPane = { querySelector: () => focusedInput };
  const callback = await loadComponentCallback(host, "focusComposer", {
    scopeKey: "a",
    currentScopeRef: { current: "a" },
    currentModeRef: { current: "floating" },
    focusFrameRef: { current: null },
    window: {
      cancelAnimationFrame() {},
      requestAnimationFrame: (action) => {
        action();
        return 1;
      },
    },
    hostRef: {
      current: {
        querySelector: (selector) => {
          if (selector === '[data-focused="true"]') return focusedPane;
          if (selector === "[data-focused]") return focusedPane;
          return hiddenInput;
        },
      },
    },
    TID_V4_COMPOSER_INPUT: "v4-composer-input",
  });
  callback();
  assert.deepEqual(events, ["focused"]);
});

test("retired floating restore cannot focus another presentation", async () => {
  const callback = await loadComponentCallback(host, "focusComposer", {
    scopeKey: "a",
    currentScopeRef: { current: "a" },
    currentModeRef: { current: "normal" },
    focusFrameRef: { current: null },
    window: {
      cancelAnimationFrame() {},
      requestAnimationFrame: (action) => {
        action();
        return 1;
      },
    },
    hostRef: { current: { querySelector: () => ({ focus: () => assert.fail("retired focus") }) } },
    TID_V4_COMPOSER_INPUT: "v4-composer-input",
  });
  callback();
});

test("retired dock measurements cannot change a new owner or slot", async () => {
  const geometry = "packages/ui/src/side-pane-full-view/adapters/useFloatingGeometry.ts";
  const originalSlot = {};
  for (const current of [
    { scopeKey: "b", mode: "floating", slotElement: originalSlot },
    { scopeKey: "a", mode: "normal", slotElement: originalSlot },
    { scopeKey: "a", mode: "floating", slotElement: {} },
  ]) {
    const height = { current: 100 };
    const callback = await loadComponentCallback(geometry, "reportComposerDockHeight", {
      scopeKey: "a",
      slotElement: originalSlot,
      currentGeometryRef: { current },
      dockHeightRef: height,
      applyRef: { current: () => assert.fail("retired measurement") },
    });
    callback(240);
    assert.equal(height.current, 100);
  }
});

test("current finite dock measurement publishes once, not per equal observer event", async () => {
  const geometry = "packages/ui/src/side-pane-full-view/adapters/useFloatingGeometry.ts";
  const slotElement = {};
  const height = { current: 100 };
  let applied = 0;
  const callback = await loadComponentCallback(geometry, "reportComposerDockHeight", {
    scopeKey: "a",
    slotElement,
    currentGeometryRef: { current: { scopeKey: "a", mode: "floating", slotElement } },
    dockHeightRef: height,
    applyRef: { current: () => applied++ },
  });
  callback(240);
  callback(240);
  callback(Number.NaN);
  callback(-1);
  assert.equal(height.current, 240);
  assert.equal(applied, 1);
});

test("late floating status from another owner or docked surface publishes nothing", async () => {
  const callback = await loadComponentCallback(host, "reportFloatingStatus", {
    scopeKey: "a",
    currentScopeRef: { current: "b" },
    currentModeRef: { current: "floating" },
    setReported: () => assert.fail("stale status"),
    setAnswerBubbles: () => assert.fail("stale answer"),
  });
  callback({ ownerKey: "a", running: false });
  const docked = await loadComponentCallback(host, "reportFloatingStatus", {
    scopeKey: "a",
    currentScopeRef: { current: "a" },
    currentModeRef: { current: "normal" },
    setReported: () => assert.fail("docked status"),
    setAnswerBubbles: () => assert.fail("docked answer"),
  });
  docked({ ownerKey: "a", running: false });
});
