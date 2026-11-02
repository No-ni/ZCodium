import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const text = await readFile(
  new URL("../../packages/ui/src/root/useRootPlatformEffects.ts", import.meta.url),
  "utf8",
);
const source = ts.createSourceFile("platform.ts", text, ts.ScriptTarget.Latest, true);
const effects = [];
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(source) === "useEffect") {
    const callback = node.arguments[0];
    if (callback?.getText(source).includes("didBootstrapInitialWorkspaceRef.current = true"))
      effects.push(callback);
  }
  ts.forEachChild(node, visit);
}
visit(source);
assert.equal(effects.length, 1);
const { outputText } = ts.transpileModule("const effect = " + effects[0].getText(source) + ";", {
  compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
});
function fixture(overrides = {}) {
  const actions = [];
  const dependencies = {
    canBootstrapInitialWorkspace: true,
    didBootstrapInitialWorkspaceRef: { current: false },
    initialWorkspaceAbsPath: "prepared-cwd",
    initialWorkspaceIdentity: "prepared-identity",
    initialWorkspacePurpose: "project",
    initialTaskId: undefined,
    initialTaskDraft: undefined,
    isRendererReloadNavigation: () => false,
    addTab: (...args) => actions.push(["tab", ...args]),
    startDraftInWorkspace: (...args) => actions.push(["draft", ...args]),
    setIsBootstrappingInitialWorkspace: (value) => actions.push(["bootstrap", value]),
    useZCodeSessionStore: {
      getState: () => ({ setActiveTaskId: (...args) => actions.push(["task", ...args]) }),
    },
    ...overrides,
  };
  const effect = new Function(...Object.keys(dependencies), outputText + "\nreturn effect;")(
    ...Object.values(dependencies),
  );
  return { effect, actions, dependencies };
}

test("prepared mobile draft carries project, placement and attachments through the existing owner once", () => {
  const draft = {
    projectId: "project-a",
    taskGroupId: "group-a",
    draftId: "draft-a",
    initialComposerDraft: { draft: { text: "fixture" }, attachments: [] },
  };
  const f = fixture({ initialTaskDraft: draft, isRendererReloadNavigation: () => true });
  f.effect();
  assert.deepEqual(f.actions, [
    [
      "tab",
      "prepared-cwd",
      { workspaceIdentity: "prepared-identity", workspacePurpose: "project" },
    ],
    ["draft", "prepared-cwd", "prepared-identity", draft],
    ["bootstrap", false],
  ]);
  f.effect();
  assert.equal(f.actions.length, 3);
});
test("explicit task selection takes precedence over a prepared draft", () => {
  const f = fixture({ initialTaskId: "task-a", initialTaskDraft: { projectId: "project-a" } });
  f.effect();
  assert.deepEqual(f.actions[1], ["task", "prepared-cwd", "task-a", "prepared-identity"]);
  assert.equal(
    f.actions.some((a) => a[0] === "draft"),
    false,
  );
});
test("renderer reload without an explicit draft preserves the running selection", () => {
  const f = fixture({ isRendererReloadNavigation: () => true });
  f.effect();
  assert.equal(
    f.actions.some((a) => a[0] === "draft" || a[0] === "task"),
    false,
  );
});
test("ordinary cold start enters a draft and restore gate delays all writes", () => {
  const f = fixture({ canBootstrapInitialWorkspace: false });
  f.effect();
  assert.deepEqual(f.actions, []);
  assert.equal(f.dependencies.didBootstrapInitialWorkspaceRef.current, false);
  const cold = fixture();
  cold.effect();
  assert.equal(cold.actions[1][0], "draft");
});
