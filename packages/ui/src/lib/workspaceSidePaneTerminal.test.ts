import { describe, expect, it } from "vitest";
import { getActiveSidePaneTab, openTerminalSidePane } from "./workspaceSidePane.js";

describe("openTerminalSidePane", () => {
  it("freezes the resolved execution cwd on the new terminal tab", () => {
    const state = openTerminalSidePane(null, {
      title: "Terminal",
      cwd: "/workspace/2026-10-11/aaaaaaaa",
    });

    expect(getActiveSidePaneTab(state)).toMatchObject({
      type: "terminal",
      cwd: "/workspace/2026-10-11/aaaaaaaa",
    });
  });
});
