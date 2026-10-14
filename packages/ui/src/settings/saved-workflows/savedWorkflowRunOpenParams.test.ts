import { describe, expect, it } from "vitest";
import type { ZCodeSavedWorkflowRun } from "@zcode/shared";
import {
  buildSavedWorkflowArtifactOpenParams,
  buildSavedWorkflowRunOpenParams,
} from "@/settings/saved-workflows/useSavedWorkflowRunOpeners.js";

const TARGET = { workspacePath: "/workspace", workspaceIdentity: "local:/workspace" };

function run(overrides: Partial<ZCodeSavedWorkflowRun> = {}): ZCodeSavedWorkflowRun {
  return {
    runId: "run-1",
    status: "completed",
    createdAt: 1,
    updatedAt: 1,
    spentTokens: 0,
    parentSessionId: "session-1",
    toolCallId: "call-1",
    cwd: "/workspace/session-a",
    artifacts: [{ id: "report", kind: "markdown", version: 1, contentType: "text/markdown" }],
    ...overrides,
  };
}

describe("saved workflow open params", () => {
  it("uses the run cwd for historical run detail", () => {
    expect(
      buildSavedWorkflowRunOpenParams(run(), "Analysis", TARGET, "session-1", "call-1"),
    ).toMatchObject({
      workspacePath: "/workspace",
      workspaceIdentity: "local:/workspace",
      fileReferenceRootPath: "/workspace/session-a",
    });
  });

  it("keeps the actual cwd as file root when the target uses parent workspacePath", () => {
    expect(
      buildSavedWorkflowRunOpenParams(
        run({ workspacePath: "/workspace" }),
        "Analysis",
        TARGET,
        "session-1",
        "call-1",
      ),
    ).toMatchObject({
      workspacePath: "/workspace",
      fileReferenceRootPath: "/workspace/session-a",
    });
  });

  it("uses the same run cwd for a historical artifact", () => {
    expect(
      buildSavedWorkflowArtifactOpenParams(run(), "report", TARGET, "session-1"),
    ).toMatchObject({
      workspacePath: "/workspace",
      workspaceIdentity: "local:/workspace",
      fileReferenceRootPath: "/workspace/session-a",
    });
  });

  it("falls back to workspacePath for older history rows without cwd", () => {
    expect(
      buildSavedWorkflowArtifactOpenParams(run({ cwd: undefined }), "report", TARGET, "session-1"),
    ).toMatchObject({ fileReferenceRootPath: "/workspace" });
  });
});
