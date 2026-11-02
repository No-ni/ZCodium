import assert from "node:assert/strict";
import test from "node:test";
import { loadComponentCallback } from "./fixtures/component-callback.mjs";

async function fixture() {
  const mountedRef = { current: true };
  const sidePaneCollapsedRef = { current: false };
  const terminalOpenRequestRef = { current: 5 };
  const latestSidePaneMemoryRef = { current: { isSidePaneCollapsed: false } };
  const saved = [],
    published = [];
  const callback = await loadComponentCallback(
    "packages/ui/src/hooks/useAppPanels.ts",
    "setIsSidePaneCollapsed",
    {
      mountedRef,
      sidePaneCollapsedRef,
      terminalOpenRequestRef,
      latestSidePaneMemoryRef,
      activeSidePaneMemoryKeyRef: { current: "fixture-task" },
      saveTaskSidePaneMemoryState: (key, value) => saved.push([key, value]),
      setIsSidePaneCollapsedState: (value) => published.push(value),
    },
  );
  return {
    callback,
    mountedRef,
    sidePaneCollapsedRef,
    terminalOpenRequestRef,
    latestSidePaneMemoryRef,
    saved,
    published,
  };
}
test("collapsing invalidates pending terminal opens and persists the same synchronous state", async () => {
  const f = await fixture();
  f.callback(true);
  assert.equal(f.terminalOpenRequestRef.current, 6);
  assert.equal(f.sidePaneCollapsedRef.current, true);
  assert.equal(f.latestSidePaneMemoryRef.current.isSidePaneCollapsed, true);
  f.callback((current) => !current);
  assert.equal(f.sidePaneCollapsedRef.current, false);
  assert.deepEqual(f.published, [true, false]);
  assert.deepEqual(f.saved, [
    ["fixture-task", { isSidePaneCollapsed: true }],
    ["fixture-task", { isSidePaneCollapsed: false }],
  ]);
});
test("unmounted side pane cannot publish state, change memory or invalidate the current owner", async () => {
  const f = await fixture();
  f.mountedRef.current = false;
  f.callback(true);
  assert.equal(f.terminalOpenRequestRef.current, 5);
  assert.deepEqual(f.saved, []);
  assert.deepEqual(f.published, []);
});
