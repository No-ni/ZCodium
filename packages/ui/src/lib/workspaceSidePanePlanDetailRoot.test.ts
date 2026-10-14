import { describe, expect, it } from "vitest";
import { openPlanDetailSidePane, type PlanDetailSidePaneTab } from "@/lib/workspaceSidePane.js";

const WORKSPACE_ROOT = "/Users/me/.zcodium/workspace/default";
const SESSION_ROOT = `${WORKSPACE_ROOT}/2026-10-11/a1b2c3d4`;

function openPlan(fileReferenceRootPath?: string) {
  const state = openPlanDetailSidePane(null, {
    workspaceKey: "default",
    workspacePath: WORKSPACE_ROOT,
    parentSessionId: "sess_a1b2c3d4-0000-4000-8000-000000000000",
    toolCallId: "call-plan",
    markdown: "# Plan",
    fileReferenceRootPath,
  });
  const tab = state.tabs.find(
    (candidate): candidate is PlanDetailSidePaneTab => candidate.type === "plan-detail",
  );
  expect(tab).toBeDefined();
  return tab as PlanDetailSidePaneTab;
}

describe("plan detail tab source root", () => {
  it("freezes the opening request root while retaining workspace identity", () => {
    const tab = openPlan(SESSION_ROOT);

    expect(tab.fileReferenceRootPath).toBe(SESSION_ROOT);
    expect(tab.workspacePath).toBe(WORKSPACE_ROOT);
  });

  it("leaves the frozen root absent for older requests", () => {
    expect(openPlan().fileReferenceRootPath).toBeUndefined();
  });
});
