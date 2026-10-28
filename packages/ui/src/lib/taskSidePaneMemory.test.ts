import { describe, expect, it } from "vitest";
import {
  buildTaskSidePaneMemoryKey,
  claimPluginUiSidePaneAutoOpen,
  getSidePaneCollapsedPreference,
  peekTaskSidePaneFullView,
  readTaskSidePaneMemoryState,
  saveTaskSidePaneCollapsedPreference,
  saveTaskSidePaneFullView,
  saveTaskSidePaneMemoryState,
} from "./taskSidePaneMemory.js";
import { buildPluginUiSurfaceKey } from "../plugin-ui/contract.js";

const target = {
  workspacePath: "/project",
  sessionId: "session",
  pluginId: "plugin",
  serverName: "server",
  resourceUri: "ui://view",
};
const callKey = (changes = {}, toolCallId = "call") =>
  buildPluginUiSurfaceKey({ ...target, ...changes }, { kind: "toolCall", toolCallId });

describe("full-view owner memory", () => {
  it("isolates equal paths by identity and keeps ordinary panel preferences untouched", () => {
    const local = buildTaskSidePaneMemoryKey({
      workspacePath: "/same/path",
      workspaceIdentity: " source-a ",
      taskId: "one",
    });
    const other = buildTaskSidePaneMemoryKey({
      workspacePath: "/same/path",
      workspaceIdentity: "source-b",
      taskId: "one",
    });
    const state = { surface: "side-pane" as const, floating: "expanded" as const };
    saveTaskSidePaneMemoryState(local, { browserUrls: { preview: "about:blank" } });
    saveTaskSidePaneCollapsedPreference(local, "one", true);
    saveTaskSidePaneFullView(local, "one", state);
    expect(peekTaskSidePaneFullView(other, "one")).toBeNull();
    expect(peekTaskSidePaneFullView(local, "one")).toEqual(state);
    const saved = readTaskSidePaneMemoryState(local);
    expect(saved.browserUrls).toEqual({ preview: "about:blank" });
    expect(getSidePaneCollapsedPreference(saved, "one")).toBe(true);
  });
  it("keeps draft, formal and switched owners independent when one exits", () => {
    const key = "full-view-owner-memory";
    const draft = { surface: "side-pane" as const, floating: "collapsed" as const };
    const formal = { surface: "conversation" as const, floating: "expanded" as const };
    saveTaskSidePaneFullView(key, null, draft);
    saveTaskSidePaneFullView(key, "formal", formal);
    expect(peekTaskSidePaneFullView(key, null)).toEqual(draft);
    expect(peekTaskSidePaneFullView(key, "formal")).toEqual(formal);
    saveTaskSidePaneFullView(key, "formal", null);
    expect(peekTaskSidePaneFullView(key, "formal")).toBeNull();
    expect(peekTaskSidePaneFullView(key, null)).toEqual(draft);
  });
});

describe("MCP App automatic sidebar opening", () => {
  it("consumes a call across remounts without changing the saved close preference", () => {
    const workspace = "sidebar-remount";
    expect(claimPluginUiSidePaneAutoOpen(workspace, callKey())).toBe(true);
    saveTaskSidePaneCollapsedPreference(workspace, target.sessionId, true);
    saveTaskSidePaneMemoryState(workspace, { browserUrls: { tab: "about:blank" } });
    expect(claimPluginUiSidePaneAutoOpen(workspace, callKey())).toBe(false);
    expect(
      getSidePaneCollapsedPreference(readTaskSidePaneMemoryState(workspace), target.sessionId),
    ).toBe(true);
    expect(claimPluginUiSidePaneAutoOpen(workspace, callKey({}, "next-call"))).toBe(true);
  });
  it("isolates execution identity, session, source and actual tool calls", () => {
    const workspace = "sidebar-isolation";
    const keys = [
      callKey(),
      callKey({ sessionId: "other" }),
      callKey({ pluginId: "other" }),
      callKey({ serverName: "other" }),
      callKey({ resourceUri: "ui://other" }),
      callKey({ workspaceIdentity: "ssh:first:/project" }),
      callKey({ workspaceIdentity: "ssh:second:/project" }),
    ];
    for (const key of keys) expect(claimPluginUiSidePaneAutoOpen(workspace, key)).toBe(true);
    for (const key of keys) expect(claimPluginUiSidePaneAutoOpen(workspace, key)).toBe(false);
    expect(claimPluginUiSidePaneAutoOpen("other-workspace-cache", keys[0]!)).toBe(true);
  });
});
