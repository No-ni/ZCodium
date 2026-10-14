import { describe, expect, it } from "vitest";
import {
  v4ConversationWorkflowRunArtifactsResultSchema,
  v4ConversationWorkflowRunWorkspaceResultSchema,
} from "@zcode/shared/zcode-protocol-v4";
import { joinFilePath, resolveDocumentFileReferenceRootPath, toFileUrl } from "@/lib/path.js";
import { resolveWorkflowWorkspaceReadPath } from "@/app-shell/WorkflowWorkspaceCard.js";

const initial = "/workspace/session";
const cwd = `${initial}/nested`;
describe("dynamic workflow journal execution roots", () => {
  it("resolves existing relative artifact paths and Markdown references against the run cwd", () => {
    const metadata = v4ConversationWorkflowRunArtifactsResultSchema.parse({
      artifacts: [],
      executionWorkspacePath: cwd,
    });
    const root = metadata.executionWorkspacePath ?? initial;
    expect(toFileUrl(joinFilePath(root, "report.html"))).toBe(`file://${cwd}/report.html`);
    expect(resolveDocumentFileReferenceRootPath("docs/report.md", root)).toBe(`${cwd}/docs`);
    expect(joinFilePath(root, "/other/absolute.html")).toBe("/other/absolute.html");
  });
  it("resolves transcript files.read paths against the same frozen run cwd", () => {
    const transcript = v4ConversationWorkflowRunWorkspaceResultSchema.parse({
      nodes: [],
      executionWorkspacePath: cwd,
    });
    expect(
      resolveWorkflowWorkspaceReadPath("report.html", transcript.executionWorkspacePath ?? initial),
    ).toBe(`${cwd}/report.html`);
  });
  it("retains old-host fallback and rejects invalid root payloads at the protocol boundary", () => {
    expect(
      v4ConversationWorkflowRunArtifactsResultSchema.parse({ artifacts: [] })
        .executionWorkspacePath ?? initial,
    ).toBe(initial);
    expect(
      v4ConversationWorkflowRunWorkspaceResultSchema.parse({ nodes: [] }).executionWorkspacePath ??
        initial,
    ).toBe(initial);
    for (const executionWorkspacePath of ["", null, 17]) {
      expect(() =>
        v4ConversationWorkflowRunArtifactsResultSchema.parse({
          artifacts: [],
          executionWorkspacePath,
        }),
      ).toThrow();
      expect(() =>
        v4ConversationWorkflowRunWorkspaceResultSchema.parse({ nodes: [], executionWorkspacePath }),
      ).toThrow();
    }
  });
});
