import assert from "node:assert/strict";
import { test } from "node:test";
import { loadComponentCallback } from "./fixtures/component-callback.mjs";

const path = "packages/ui/src/hooks/useSettingService.ts";
async function updateCallback({ persisted, snapshot = persisted, failUpdate, syncError } = {}) {
  const calls = [];
  const fail = syncError ? new Error("sync unavailable") : null;
  const callback = await loadComponentCallback(path, "update", {
    measureOperation: async (_scope, action) => action(),
    settingService: {
      update: async (patch) => {
        calls.push(["persist", patch]);
        if (failUpdate) throw new Error("persist failed");
      },
      get: async () => persisted,
    },
    platform: { syncAppSettings: (patch) => calls.push(["platform", patch]) },
    refresh: async () => calls.push(["refresh"]),
    settingsStore: { snapshot: { settings: snapshot } },
    zcodeAgentService: {
      syncAppRuntimePreferences: async (value) => {
        calls.push(["agent", value]);
        if (fail) throw fail;
      },
    },
    botsService: { syncAppRuntimePreferences: async (value) => calls.push(["bots", value]) },
    broadcastService: { send: async (value) => calls.push(["broadcast", value.payload]) },
    APP_RUNTIME_PREFERENCES_CHANGED_BROADCAST_CHANNEL: "settings:app-runtime-preferences",
  });
  return { callback, calls, fail };
}

test("ToolSearch setting keeps the committed question preference and syncs one snapshot", async () => {
  const persisted = { askUserQuestionAutoResolutionEnabled: false, toolSearchMode: "local" };
  const { callback, calls } = await updateCallback({ persisted });
  await callback({ toolSearchMode: "local" });
  assert.deepEqual(
    calls.filter(([name]) => ["agent", "bots", "broadcast"].includes(name)),
    [
      ["agent", persisted],
      ["bots", persisted],
      ["broadcast", persisted],
    ],
  );
  assert.equal(calls[0][0], "persist");
});

test("question preference does not reset the committed ToolSearch mode from a stale UI refresh", async () => {
  const persisted = { askUserQuestionAutoResolutionEnabled: true, toolSearchMode: "auto" };
  const { callback, calls } = await updateCallback({
    persisted,
    snapshot: { askUserQuestionAutoResolutionEnabled: false, toolSearchMode: "off" },
  });
  await callback({ askUserQuestionAutoResolutionEnabled: true });
  assert.deepEqual(
    calls.find(([name]) => name === "agent"),
    ["agent", persisted],
  );
});

test("failed settings persistence never syncs or broadcasts runtime preferences", async () => {
  const { callback, calls } = await updateCallback({ persisted: {}, failUpdate: true });
  await assert.rejects(callback({ toolSearchMode: "local" }), /persist failed/);
  assert.deepEqual(calls, [["persist", { toolSearchMode: "local" }]]);
});

test("runtime sync failure still broadcasts the committed setting and reports failure", async () => {
  const persisted = { askUserQuestionAutoResolutionEnabled: true, toolSearchMode: "local" };
  const { callback, calls, fail } = await updateCallback({ persisted, syncError: true });
  await assert.rejects(callback({ toolSearchMode: "local" }), (error) => error === fail);
  assert.deepEqual(calls.at(-1), ["broadcast", persisted]);
});

test("unrelated settings do not admit a runtime preference update", async () => {
  const { callback, calls } = await updateCallback({ persisted: {} });
  await callback({ locale: "en-US" });
  assert.equal(
    calls.some(([name]) => ["agent", "bots", "broadcast"].includes(name)),
    false,
  );
});
