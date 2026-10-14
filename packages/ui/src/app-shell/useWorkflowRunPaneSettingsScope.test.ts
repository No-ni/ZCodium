import { describe, expect, it } from "vitest";
import { workflowRunTabScope } from "@/app-shell/useWorkflowRunPaneSettings.js";

describe("workflowRunTabScope", () => {
  it("keeps the frozen execution root when opening a successor run", () => {
    expect(
      workflowRunTabScope({
        workspacePath: "/workspace",
        workspaceIdentity: "local:/workspace",
        remoteSessionId: "remote-a",
        fileReferenceRootPath: "/workspace/session-a",
      }),
    ).toEqual({
      workspacePath: "/workspace",
      workspaceIdentity: "local:/workspace",
      remoteSessionId: "remote-a",
      fileReferenceRootPath: "/workspace/session-a",
    });
  });
});
