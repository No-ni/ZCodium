import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { tsImport } from "tsx/esm/api";

const app = await readFile("packages/ui/src/App.tsx", "utf8");
const preview = await readFile("packages/ui/src/PreviewPane.tsx", "utf8");
const shell = await readFile("packages/ui/src/app-shell/WorkspaceShellLayout.tsx", "utf8");

test("Shell forwards the primary draft binding and the same execution directory to terminal", () => {
  for (const property of ["primaryDraftScopeToken", "onPrimaryDraftEffectiveSessionBindingChange"])
    assert.match(shell, new RegExp(`${property}=\\{\\s*${property}\\s*\\}`));
  assert.match(shell, /cwd=\{terminalExecutionWorkspacePath\}/);
  assert.match(shell, /terminalWorkspaceKey=\{terminalWorkspaceKey\}/);
  assert.match(shell, /executionWorkspacePathReady=\{terminalExecutionPathReady\}/);
});

function productionExpression(name, dependencies) {
  const file = ts.createSourceFile("App.tsx", app, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === name)
      expression = node.initializer.getText(file);
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(expression, name);
  return new Function(...Object.keys(dependencies), `return (${expression});`)(
    ...Object.values(dependencies),
  );
}

test("App resolves execution from the active session or current primary draft owner", () => {
  const resolve = (activeTaskId, projectedPrimaryDraftBinding) =>
    productionExpression("sessionPathTargetId", {
      activeTaskId,
      projectedPrimaryDraftBinding,
    });
  assert.equal(resolve("accepted", { sessionId: "prewarm" }), "accepted");
  assert.equal(resolve(null, { sessionId: "prewarm" }), "prewarm");
  assert.equal(resolve(null, null), null);
  assert.ok(
    !app.includes(".draftSessionId"),
    "deleted workspace state must not become a second session owner",
  );
});

test("late draft binding from a previous scope cannot take execution ownership", async () => {
  const { applyPrimaryDraftEffectiveSessionBinding } = await tsImport(
    "../../packages/ui/src/v4/primaryDraftSessionBinding.ts",
    import.meta.url,
  );
  const context = {
    workspaceKey: "fixture-local",
    activeTaskId: null,
    isLocalWorkspace: true,
    primaryPaneId: "primary",
    scopeToken: {},
  };
  const binding = {
    workspaceKey: context.workspaceKey,
    paneId: context.primaryPaneId,
    sessionId: "prewarm",
    generation: {},
  };
  assert.equal(
    applyPrimaryDraftEffectiveSessionBinding(
      null,
      { type: "bind", binding, scopeToken: {} },
      context,
    ),
    null,
  );
  assert.equal(
    applyPrimaryDraftEffectiveSessionBinding(
      null,
      { type: "bind", binding, scopeToken: context.scopeToken },
      context,
    ),
    binding,
  );
});

test("preview image references use the existing source and target identity admission", () => {
  const file = ts.createSourceFile(
    "PreviewPane.tsx",
    preview,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const resolve = file.statements.find(
    (node) =>
      ts.isFunctionDeclaration(node) && node.name?.text === "resolvePreviewPaneImageFileReference",
  );
  assert.ok(resolve);
  assert.match(preview, /const imageFileReference\s*=\s*resolvePreviewPaneImageFileReference\(/);
  const { outputText } = ts.transpileModule(resolve.getText(file).replace("export ", ""), {
    compilerOptions: { target: ts.ScriptTarget.ESNext },
  });
  const reference = new Function(
    "isWorkspaceFilePathInside",
    "getWorkspaceFileRelativePath",
    "getPathLeaf",
    `${outputText}; return resolvePreviewPaneImageFileReference;`,
  )(
    (root, path) => path.startsWith(root + "/"),
    (root, path) => path.slice(root.length + 1),
    (path) => path.split("/").at(-1),
  );
  const source = {
    path: "/fixture/image.png",
    workspacePath: "/fixture",
    workspaceIdentity: "remote-a",
    workspaceRemoteSessionId: "attachment-a",
    title: "image",
  };
  assert.equal(reference(source, "/fixture", "remote-b"), undefined);
  assert.equal(reference(source, "/fixture", "remote-a").workspaceIdentity, "remote-a");
  assert.equal(
    reference(
      { ...source, workspaceIdentity: undefined, workspaceRemoteSessionId: undefined },
      "/fixture",
      "/fixture",
    ).relativePath,
    "image.png",
  );
});
