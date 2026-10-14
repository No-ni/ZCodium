import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { getGenUiOutputDirectory } from "./genUiPaths.js";

const scope = { workspacePath: resolve("workspace"), sessionId: "session" };
const root = resolve("user-data", "visualizations");
describe("Gen UI output directory", () => {
  it("isolates sessions and workspace identities with a stable safe path", () => {
    const directory = getGenUiOutputDirectory(root, scope);
    expect(directory).toMatch(/[a-f0-9]{64}$/u);
    expect(getGenUiOutputDirectory(root, { ...scope })).toBe(directory);
    expect(getGenUiOutputDirectory(root, { ...scope, sessionId: "../other" })).not.toBe(directory);
    expect(
      getGenUiOutputDirectory(root, { ...scope, workspaceIdentity: "ssh:first:/workspace" }),
    ).not.toBe(directory);
    const remote = { ...scope, workspaceIdentity: "ssh:first:/workspace" };
    expect(getGenUiOutputDirectory(root, { ...remote, workspacePath: resolve("other-path") })).toBe(
      getGenUiOutputDirectory(root, remote),
    );
    expect(
      getGenUiOutputDirectory(root, { ...remote, workspaceIdentity: "ssh:second:/workspace" }),
    ).not.toBe(getGenUiOutputDirectory(root, remote));
  });
  it("rejects relative roots and output inside the workspace", () => {
    expect(() => getGenUiOutputDirectory("relative", scope)).toThrow();
    expect(() => getGenUiOutputDirectory(scope.workspacePath, scope)).toThrow();
    expect(() => getGenUiOutputDirectory(join(scope.workspacePath, ".zcode"), scope)).toThrow();
  });
  it("uses the trusted conversation session directory while retaining project and legacy output", () => {
    const executionWorkspacePath = join(scope.workspacePath, "2026-10-13", "a1b2c3d4");
    const conversation = { conversationWorkspaceRoot: scope.workspacePath, executionWorkspacePath };
    expect(getGenUiOutputDirectory(root, scope, conversation)).toBe(
      join(executionWorkspacePath, "visualizations"),
    );
    expect(
      getGenUiOutputDirectory(root, scope, {
        ...conversation,
        executionWorkspacePath: scope.workspacePath,
      }),
    ).toBe(getGenUiOutputDirectory(root, scope));
    expect(
      getGenUiOutputDirectory(
        root,
        { ...scope, workspaceIdentity: "remote:fixture" },
        conversation,
      ),
    ).toBe(getGenUiOutputDirectory(root, { ...scope, workspaceIdentity: "remote:fixture" }));
    expect(
      getGenUiOutputDirectory(root, scope, {
        ...conversation,
        conversationWorkspaceRoot: resolve("another"),
      }),
    ).toBe(getGenUiOutputDirectory(root, scope));
    expect(
      getGenUiOutputDirectory(root, scope, {
        ...conversation,
        executionWorkspacePath: resolve("outside"),
      }),
    ).toBe(getGenUiOutputDirectory(root, scope));
    expect(() =>
      getGenUiOutputDirectory(root, scope, { ...conversation, executionWorkspacePath: "relative" }),
    ).toThrow("absolute");
  });
});
