import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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

test("Main window identity survives Host replacement and retires at window close", async () => {
  let ids = 0;
  const api = await functions(
    "packages/desktop/src/main/desktopHostProcess.ts",
    [
      "windowBrowserBackendIdentities",
      "ensureWindowBrowserBackendIdentity",
      "getWindowBrowserBackendIdentity",
    ],
    { randomUUID: () => `fixture-browser-${++ids}` },
    "({ensureWindowBrowserBackendIdentity,getWindowBrowserBackendIdentity})",
  );
  const win = new EventEmitter();
  win.isDestroyed = () => false;
  assert.equal(api.getWindowBrowserBackendIdentity(win), undefined);
  const identity = api.ensureWindowBrowserBackendIdentity(win);
  assert.equal(api.ensureWindowBrowserBackendIdentity(win), identity);
  assert.equal(ids, 1);
  win.emit("closed");
  assert.equal(api.getWindowBrowserBackendIdentity(win), undefined);
  const other = new EventEmitter();
  other.isDestroyed = () => false;
  assert.notEqual(api.ensureWindowBrowserBackendIdentity(other).id, identity.id);
});

test("Main rejects stale and uninitialized browser identities before side effects", async () => {
  const contexts = [];
  let dialogs = 0;
  let identity = { id: "fixture-current", generation: 1 };
  const execute = await functions(
    "packages/desktop/src/main/index.ts",
    ["runBrowserCommandOnView"],
    {
      getWindowBrowserBackendIdentity: () => identity,
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
          return { ok: true };
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
    command: { method: "createTab" },
  };
  assert.equal((await execute({ ...params, browserId: "retired" })).ok, false);
  assert.equal((await execute({ ...params, browserGeneration: 0 })).ok, false);
  identity = undefined;
  assert.equal((await execute(params)).ok, false);
  assert.equal(contexts.length, 0);
  assert.equal(dialogs, 0);
  identity = { id: "fixture-current", generation: 1 };
  assert.equal((await execute(params)).ok, true);
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].browserId, identity.id);
  assert.equal(contexts[0].browserGeneration, 1);
});
