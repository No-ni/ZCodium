import assert from "node:assert/strict";
import { test } from "node:test";
import { loadComponentCallback } from "./fixtures/component-callback.mjs";

const source = "packages/ui/src/v4/WorkbenchPane.tsx";
test("a hidden pane cannot regain focus from a late capture event", async () => {
  const callback = await loadComponentCallback(source, "handleFocusRequest", {
    hidden: true,
    paneId: "hidden-pane",
    onFocusRequest: () => assert.fail("Hidden pane regained focus"),
  });
  callback();
});
test("a visible pane preserves the original focus admission", async () => {
  const events = [];
  const callback = await loadComponentCallback(source, "handleFocusRequest", {
    hidden: false,
    paneId: "focused-pane",
    onFocusRequest: (id) => events.push(id),
  });
  callback();
  assert.deepEqual(events, ["focused-pane"]);
});
