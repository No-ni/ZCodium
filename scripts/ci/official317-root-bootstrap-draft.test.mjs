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
    onComplete: () => f.actions.push(["complete"]),
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
    ["complete"],
    ["bootstrap", false],
  ]);
  f.effect();
  assert.equal(f.actions.length, 4);
});
test("explicit task selection takes precedence over a prepared draft", () => {
  let completed = 0;
  const f = fixture({
    initialTaskId: "task-a",
    initialTaskDraft: { projectId: "project-a", onComplete: () => completed++ },
  });
  f.effect();
  assert.deepEqual(f.actions[1], ["task", "prepared-cwd", "task-a", "prepared-identity"]);
  assert.equal(
    f.actions.some((a) => a[0] === "draft"),
    false,
  );
  assert.equal(completed, 0);
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
  let completed = 0;
  const f = fixture({
    canBootstrapInitialWorkspace: false,
    initialTaskDraft: { onComplete: () => completed++ },
  });
  f.effect();
  assert.deepEqual(f.actions, []);
  assert.equal(f.dependencies.didBootstrapInitialWorkspaceRef.current, false);
  assert.equal(completed, 0);
  const cold = fixture();
  cold.effect();
  assert.equal(cold.actions[1][0], "draft");
});

test("missing prepared workspace never completes the draft request", () => {
  let completed = 0;
  const f = fixture({
    initialWorkspaceAbsPath: undefined,
    initialTaskDraft: { onComplete: () => completed++ },
  });
  f.effect();
  assert.deepEqual(f.actions, [["bootstrap", false]]);
  assert.equal(completed, 0);
});

test("draft owner failure never reports completion or readiness", () => {
  let completed = 0;
  const failure = new Error("fixture-draft-owner-failed");
  const f = fixture({
    initialTaskDraft: { onComplete: () => completed++ },
    startDraftInWorkspace: () => {
      throw failure;
    },
  });
  assert.throws(f.effect, (error) => error === failure);
  assert.equal(completed, 0);
  assert.equal(
    f.actions.some((action) => action[0] === "bootstrap"),
    false,
  );
  f.effect();
  assert.equal(completed, 0);
});

for (const kind of ["draft", "task"]) {
  test(`invalidated initial ${kind} lease blocks all navigation writes and late revival`, () => {
    let current = true;
    let completed = 0;
    const f = fixture({
      initialTaskId: kind === "task" ? "task-a" : undefined,
      initialTaskDraft: { isCurrent: () => current, onComplete: () => completed++ },
    });
    // 模拟 Root 已完成 render、其 passive effect 尚未执行时协议撤销旧 scope。
    current = false;
    f.effect();
    assert.deepEqual(f.actions, [["bootstrap", false]]);
    assert.equal(completed, 0);
    current = true;
    f.effect();
    assert.deepEqual(f.actions, [["bootstrap", false]]);
    assert.equal(completed, 0);
  });
}

const rootText = await readFile(new URL("../../packages/ui/src/Root.tsx", import.meta.url), "utf8");
const rootSource = ts.createSourceFile(
  "Root.tsx",
  rootText,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const baseEffects = [];
function visitRoot(node) {
  if (ts.isCallExpression(node) && node.expression.getText(rootSource) === "useEffect") {
    const callback = node.arguments[0];
    if (callback?.getText(rootSource).includes("registerBaseWorkspaceServices(services)")) {
      baseEffects.push(callback);
    }
  }
  ts.forEachChild(node, visitRoot);
}
visitRoot(rootSource);
assert.equal(baseEffects.length, 1);
const baseOutput = ts.transpileModule(
  "const effect = " + baseEffects[0].getText(rootSource) + ";",
  {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  },
).outputText;

function baseFixture(initialTaskDraft) {
  const services = { id: "old-accessor" };
  const state = { base: null, registrations: [] };
  const registerBaseWorkspaceServices = (accessor) => {
    state.base = accessor;
    state.registrations.push(accessor);
  };
  const effect = new Function(
    "services",
    "initialTaskDraft",
    "registerBaseWorkspaceServices",
    baseOutput + "\nreturn effect;",
  )(services, initialTaskDraft, registerBaseWorkspaceServices);
  return { effect, services, state };
}

for (const initialTaskDraft of [undefined, { isCurrent: () => true }]) {
  test(`base registration preserves the ${initialTaskDraft ? "current mobile" : "ordinary"} Root entry`, () => {
    const f = baseFixture(initialTaskDraft);
    f.effect();
    assert.equal(f.state.base, f.services);
    assert.deepEqual(f.state.registrations, [f.services]);
  });
}

for (const hasReplacement of [false, true]) {
  test(`invalidated Root base effect cannot ${hasReplacement ? "overwrite the replacement accessor" : "revive a released accessor"}`, () => {
    let current = true;
    const f = baseFixture({ isCurrent: () => current });
    const replacement = hasReplacement ? { id: "new-accessor" } : null;
    // 模拟 bridge owner 已同步清退或换代，而旧 Root 的 passive effect 仍在排队。
    current = false;
    f.state.base = replacement;
    f.effect();
    assert.equal(f.state.base, replacement);
    assert.deepEqual(f.state.registrations, []);
  });
}
