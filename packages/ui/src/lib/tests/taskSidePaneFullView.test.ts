import { describe, expect, it } from "vitest";
import {
  buildTaskSidePaneMemoryKey,
  peekTaskSidePaneFullView,
  readTaskSidePaneMemoryState,
  saveTaskSidePaneFullView,
  saveTaskSidePaneMemoryState,
} from "../taskSidePaneMemory.js";

const enter = { surface: "side-pane", floating: "collapsed" } as const;
describe("full-view uses the existing workspace memory", () => {
  it("separates same-path Source identities and session owners", () => {
    const first = buildTaskSidePaneMemoryKey({
      workspacePath: "/same",
      workspaceIdentity: " source:first ",
      taskId: "a",
    });
    const second = buildTaskSidePaneMemoryKey({
      workspacePath: "/same",
      workspaceIdentity: "source:second",
      taskId: "a",
    });
    saveTaskSidePaneFullView(first, "a", enter);
    expect(peekTaskSidePaneFullView(first, "a")).toEqual(enter);
    expect(peekTaskSidePaneFullView(first, "b")).toBeNull();
    expect(peekTaskSidePaneFullView(second, "a")).toBeNull();
  });
  it("keeps tab, URL and close preferences through full-view writes", () => {
    const key = "full-view-memory-preserves";
    saveTaskSidePaneMemoryState(key, {
      browserUrls: { tab: "about:blank" },
      sidePaneCollapsedByOwner: { a: false },
    });
    saveTaskSidePaneFullView(key, "a", enter);
    saveTaskSidePaneMemoryState(key, { activeGitSourceId: "staged" });
    expect(peekTaskSidePaneFullView(key, "a")).toEqual(enter);
    const state = readTaskSidePaneMemoryState(key);
    expect(state.browserUrls).toEqual({ tab: "about:blank" });
    expect(state.sidePaneCollapsedByOwner.a).toBe(false);
  });
  it("clears only the explicitly closed owner, including draft", () => {
    const key = "full-view-memory-close";
    saveTaskSidePaneFullView(key, null, enter);
    saveTaskSidePaneFullView(key, "a", enter);
    saveTaskSidePaneFullView(key, "b", { surface: "conversation", floating: "expanded" });
    saveTaskSidePaneFullView(key, "a", null);
    expect(peekTaskSidePaneFullView(key, "a")).toBeNull();
    expect(peekTaskSidePaneFullView(key, null)).toEqual(enter);
    expect(peekTaskSidePaneFullView(key, "b")?.surface).toBe("conversation");
  });
  it("does not expose a mutable memory record or create one for a missing workspace", () => {
    const key = "full-view-memory-immutable";
    saveTaskSidePaneFullView(key, "a", enter);
    expect(Object.isFrozen(peekTaskSidePaneFullView(key, "a"))).toBe(true);
    saveTaskSidePaneFullView(null, "a", enter);
    expect(peekTaskSidePaneFullView(null, "a")).toBeNull();
  });
});
