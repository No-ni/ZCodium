import assert from "node:assert/strict";
import test from "node:test";
import { loadComponentCallback } from "./fixtures/component-callback.mjs";
import { useConversationShareSelectionStore as store } from "../../packages/ui/src/store/conversationShareSelectionStore.js";

const path = "packages/ui/src/v4/SessionPane.tsx";
function fixture() {
  store.getState().resetForTests();
  store.getState().openShare("task");
  store.getState().syncAvailableTurns("task", [
    { rowId: 1, productTurnId: "one" },
    { rowId: 2, productTurnId: "two" },
  ]);
}

test("SessionPane confirmation commits pending scope and cancellation rolls it back", async () => {
  fixture();
  store.getState().beginSelectionEdit("task");
  store.getState().togglePendingRow("task", 1);
  const next = await loadComponentCallback(path, "handleShareNext", {
    sessionId: "task",
    sharePublishing: false,
    sharePreflight: { status: "ready", blockingIssues: [] },
    updateShareDockState: store.getState().updateDockState,
    goToShareConfiguration: store.getState().confirmSelectionEdit,
  });
  next();
  assert.deepEqual(store.getState().drafts.task.excludedRowIds, [1]);
  assert.equal(store.getState().drafts.task.pendingExcludedRowIds, null);
  store.getState().beginSelectionEdit("task");
  store.getState().togglePendingRow("task", 2);
  const cancel = await loadComponentCallback(path, "handleShareSelectionCancel", {
    sessionId: "task",
    cancelShareSelection: store.getState().cancelSelectionEdit,
  });
  cancel();
  assert.deepEqual(store.getState().drafts.task.excludedRowIds, [1]);
  assert.equal(store.getState().drafts.task.pendingExcludedRowIds, null);
});

test("SessionPane rejects publish while editing, closed or blocked", async () => {
  fixture();
  let calls = 0;
  const run = (preflight) =>
    loadComponentCallback(path, "handleShareConfirm", {
      sessionId: "task",
      useConversationShareSelectionStore: store,
      sharePublishing: false,
      sharePreflight: preflight,
      handleExportConversation: () => {
        calls++;
      },
    });
  const ready = await run({ status: "ready", blockingIssues: [] });
  store.getState().beginSelectionEdit("task");
  ready();
  assert.equal(calls, 0);
  store.getState().cancelSelectionEdit("task");
  const blocked = await run({ status: "ready", blockingIssues: [{ code: "rows_limit" }] });
  blocked();
  assert.equal(calls, 0);
  store.getState().closeShare("task");
  ready();
  assert.equal(calls, 0);
  store.getState().openShare("task");
  ready();
  assert.equal(calls, 1);
});

test("Reopening a completed local export clears the previous result and attempt", () => {
  fixture();
  store.getState().updateDockState("task", {
    exportedFile: { name: "fixture.zcode", downloadStarted: false },
    attempt: { key: "previous", clientRequestId: "previous" },
  });
  store.getState().closeShare("task");
  store.getState().openShare("task");
  assert.equal(store.getState().dockStates.task.exportedFile, null);
  assert.equal(store.getState().dockStates.task.attempt, null);
});
