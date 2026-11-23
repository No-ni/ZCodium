import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function functions(path, names, deps, returnValue) {
  const text = await readFile(new URL("../../" + path, import.meta.url), "utf8");
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const nodes = file.statements.filter((node) =>
    names.includes(
      node.name?.text ??
        (ts.isVariableStatement(node)
          ? node.declarationList.declarations[0]?.name.getText(file)
          : ""),
    ),
  );
  assert.equal(nodes.length, names.length, "production declarations must exist");
  const source = nodes.map((node) => node.getText(file).replace(/^export\s+/, "")).join("\n");
  const code = ts.transpileModule(source + "\nreturn " + returnValue + ";", {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
  return new Function(...Object.keys(deps), code)(...Object.values(deps));
}

test("Main forwards the current identity and control scope to the single resource owner", async () => {
  const contexts = [];
  let dialogs = 0;
  const identity = { id: "fixture-current", generation: 1 };
  const execute = await functions(
    "packages/desktop/src/main/index.ts",
    ["runBrowserCommandOnView"],
    {
      embeddedBrowserDialogController: {
        beginAutomation() {
          dialogs++;
          return () => {};
        },
      },
      resolveBrowserOperationTabId: () => undefined,
      browserOperationResetsResizeBaseline: () => false,
      browserGuestManager: {
        async execute(context) {
          contexts.push(context);
          return {
            ok:
              context.browserId === identity.id &&
              context.browserGeneration === identity.generation,
          };
        },
      },
      logger: { debug() {}, error() {} },
      PlatformChannels: {},
    },
    "runBrowserCommandOnView",
  );
  const params = {
    win: { id: 1, isDestroyed: () => false },
    requestId: "request",
    sessionId: "session",
    browserId: identity.id,
    browserGeneration: 1,
    controlScopeId: "fixture-scope",
    workspaceIdentity: "  fixture-workspace  ",
    command: { method: "createTab" },
  };
  assert.equal((await execute({ ...params, browserId: "retired" })).ok, false);
  assert.equal((await execute({ ...params, browserGeneration: 0 })).ok, false);
  assert.equal((await execute(params)).ok, true);
  assert.equal(contexts.length, 3);
  assert.equal(dialogs, 3);
  assert.equal(contexts[2].browserId, identity.id);
  assert.equal(contexts[2].browserGeneration, 1);
  assert.equal(contexts[2].controlScopeId, params.controlScopeId);
  assert.equal(contexts[2].workspaceKey, "fixture-workspace");
});
