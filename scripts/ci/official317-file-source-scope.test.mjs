import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { loadComponentCallback } from "./fixtures/component-callback.mjs";

test("Markdown source metadata selects exact scope while legacy links remain ambient", async () => {
  const path = "packages/ui/src/components/ai-elements/message.tsx";
  const source = ts.createSourceFile(
    path,
    await readFile(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const component = source.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "ScopedMessageFileLink",
  );
  const calls = [];
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === "useWorkspaceServices")
      calls.push(node);
    ts.forEachChild(node, visit);
  }
  visit(component);
  assert.equal(calls.length, 1);
  const args = calls[0].arguments;
  assert.equal(args[1].getText(source), "fileLink.workspaceRemoteSessionId");
  assert.equal(args[2].getText(source), "fileLink.workspaceIdentity");
  assert.match(
    args[4]?.getText(source) ?? "",
    /fileLink\.workspacePath.*\?\s*"exact"\s*:\s*"ambient"/s,
  );
});

for (const kind of ["remote", "base-local", "remote-unavailable"]) {
  test(`actual Shell file callback keeps ${kind} source isolated`, async () => {
    const reads = [],
      resolutions = [],
      views = [];
    const accessor = (name) => ({
      fileService: {
        stat: async (params) => {
          reads.push({ name, ...params });
          return { type: "file" };
        },
      },
    });
    const baseServices = accessor("base"),
      services = accessor("ambient"),
      sourceServices = accessor("source");
    const callback = await loadComponentCallback(
      "packages/ui/src/app-shell/WorkspaceShellLayout.tsx",
      "handleOpenMarkdownFileLink",
      {
        workspaceReadOnlyReason: null,
        services,
        baseServices,
        selectWorkspacePathFileService: (target, ambient, base) =>
          target.serviceScope === "base-local" ? base : ambient,
        resolveTaskExecutionWorkspaceServices: (params) => {
          resolutions.push(params);
          return kind === "remote-unavailable" ? null : sourceServices;
        },
        shouldOpenAssistantHtmlInBrowser: () => false,
        handleOpenCodeViewer: (view) => views.push(view),
        getPathLeaf: () => "file.txt",
        shouldFallbackWorkspacePathToCodeViewer: () => false,
        logger: { warn() {} },
        toast() {},
        intl: { formatMessage: () => "Unavailable" },
        REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE: "remote-disconnected",
        isWebRemoteControlShell: false,
      },
    );
    const target = {
      path: "fixture/file.txt",
      workspacePath: "fixture",
      workspaceIdentity: "source-a",
      workspaceRemoteSessionId: "source-session",
      ...(kind === "base-local" ? { serviceScope: "base-local" } : {}),
    };
    await callback(target);
    assert.deepEqual(
      reads,
      kind === "remote-unavailable"
        ? []
        : [{ name: kind === "base-local" ? "base" : "source", path: target.path }],
    );
    assert.equal(resolutions.length, kind === "base-local" ? 0 : 1);
    if (resolutions.length) {
      assert.equal(resolutions[0].baseServices, baseServices);
      assert.equal(resolutions[0].workspaceIdentity, target.workspaceIdentity);
      assert.equal(resolutions[0].remoteSessionId, target.workspaceRemoteSessionId);
    }
    if (kind !== "remote-unavailable")
      assert.equal(views[0].workspaceIdentity, target.workspaceIdentity);
  });
}
