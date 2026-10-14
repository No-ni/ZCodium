import { describe, expect, it } from "vitest";
import { resolveWorkflowWorkspaceReadPath } from "@/app-shell/WorkflowWorkspaceCard.js";
import { withCodeViewerWorkspaceScope } from "@/lib/codeViewerWorkspaceScope.js";

describe("resolveWorkflowWorkspaceReadPath", () => {
  it("joins relative read paths to the frozen run root", () => {
    expect(resolveWorkflowWorkspaceReadPath("docs/report.md", "/workspace/session-a")).toBe(
      "/workspace/session-a/docs/report.md",
    );
  });

  it("preserves POSIX, drive, and UNC absolute paths", () => {
    expect(resolveWorkflowWorkspaceReadPath("/tmp/report.md", "/workspace/session-a")).toBe(
      "/tmp/report.md",
    );
    expect(resolveWorkflowWorkspaceReadPath("C:\\repo\\report.md", "C:\\repo\\session-a")).toBe(
      "C:\\repo\\report.md",
    );
    expect(resolveWorkflowWorkspaceReadPath("\\\\server\\share\\report.md", "C:\\repo")).toBe(
      "\\\\server\\share\\report.md",
    );
    expect(
      resolveWorkflowWorkspaceReadPath("docs\\report.md", "\\\\server\\share\\session-a"),
    ).toBe("\\\\server\\share\\session-a\\docs\\report.md");
  });

  it("opens read files with the workflow tab's frozen local or remote scope", () => {
    expect(
      withCodeViewerWorkspaceScope(
        { type: "file", title: "report.md", path: "\\\\server\\share\\session\\report.md" },
        {
          workspacePath: "\\\\server\\share\\repo",
          fileReferenceRootPath: "\\\\server\\share\\session",
          workspaceIdentity: "ssh:host:/repo",
          workspaceRemoteSessionId: "remote-1",
        },
      ),
    ).toEqual({
      type: "file",
      title: "report.md",
      path: "\\\\server\\share\\session\\report.md",
      workspacePath: "\\\\server\\share\\repo",
      fileReferenceRootPath: "\\\\server\\share\\session",
      workspaceIdentity: "ssh:host:/repo",
      workspaceRemoteSessionId: "remote-1",
    });
  });
});
