import { describe, expect, it } from "vitest";
import type { ZCodeSavedWorkflowRun } from "@zcode/shared";
import {
  buildGlobalRunProjectResolver,
  findProjectForSavedWorkflowRun,
} from "@/settings/saved-workflows/globalWorkflowGroupHelpers.js";
import { buildSavedWorkflowRunOpenParams } from "@/settings/saved-workflows/useSavedWorkflowRunOpeners.js";

const PROJECT = {
  workspacePath: "/workspace",
  workspaceIdentity: "local:/workspace",
  label: "Workspace",
};

function run(overrides: Partial<ZCodeSavedWorkflowRun> = {}): ZCodeSavedWorkflowRun {
  return {
    runId: "run-1",
    status: "completed",
    createdAt: 1,
    updatedAt: 1,
    spentTokens: 0,
    parentSessionId: "session-1",
    toolCallId: "call-1",
    cwd: "/workspace/.zcodium/sessions/2026/10/session-a",
    workspacePath: "/workspace",
    ...overrides,
  };
}

describe("global saved workflow run project", () => {
  it("matches the parent workspace when the execution cwd is nested", () => {
    const nestedRun = run();
    const target = findProjectForSavedWorkflowRun([PROJECT], nestedRun);

    expect(target).toBe(PROJECT);
    expect(buildGlobalRunProjectResolver([PROJECT])(nestedRun)).toEqual({
      label: "Workspace",
      title: "/workspace/.zcodium/sessions/2026/10/session-a",
      canOpen: true,
    });
    expect(
      target &&
        buildSavedWorkflowRunOpenParams(nestedRun, "Analysis", target, "session-1", "call-1"),
    ).toMatchObject({
      workspacePath: "/workspace",
      workspaceIdentity: "local:/workspace",
      fileReferenceRootPath: "/workspace/.zcodium/sessions/2026/10/session-a",
    });
  });

  it("falls back to cwd for history rows without workspacePath", () => {
    expect(
      findProjectForSavedWorkflowRun(
        [PROJECT],
        run({ workspacePath: undefined, cwd: "/workspace" }),
      ),
    ).toBe(PROJECT);
  });
});
