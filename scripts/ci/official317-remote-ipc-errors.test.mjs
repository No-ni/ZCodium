import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
async function handler(create) {
  const text = await readFile(
    new URL("../../packages/desktop/src/main/desktopMainIpcRemote.ts", import.meta.url),
    "utf8",
  );
  const file = ts.createSourceFile("ipc.ts", text, ts.ScriptTarget.Latest, true);
  let callback;
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(file) === "ipcMain.handle" &&
      node.arguments[0].getText(file) === "PlatformChannels.ConnectRemote"
    )
      callback = node.arguments[1];
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(callback);
  const logs = [];
  const deps = {
    options: {
      createRemoteWorkspaceSession: create,
      logger: { error: (...args) => logs.push(args), warn: (...args) => logs.push(args) },
    },
    BrowserWindow: { fromWebContents: () => ({}) },
    remoteTargetSchema: { safeParse: (data) => ({ success: true, data }) },
    normalizeUnknownError: (error) => ({ message: error.message, code: error.code }),
  };
  const { outputText } = ts.transpileModule(`const actual = ${callback.getText(file)};`, {
    compilerOptions: { target: ts.ScriptTarget.ESNext },
  });
  return {
    run: new Function(...Object.keys(deps), `${outputText}\nreturn actual;`)(
      ...Object.values(deps),
    ),
    logs,
  };
}
test("connect failure carries its code to the renderer and keeps raw errors out of logs", async () => {
  const error = Object.assign(new Error("fixture-visible-error"), {
    code: "source-server-start-required",
  });
  const { run, logs } = await handler(async () => {
    throw error;
  });
  const result = await run({ sender: {} }, { target: { kind: "wsl" } });
  assert.deepEqual(result, {
    success: false,
    error: "fixture-visible-error",
    reasonCode: "source-server-start-required",
  });
  assert.deepEqual(logs, [["[connect-remote] connection failed"]]);
});
test("connect success returns only the actual session acknowledgement", async () => {
  const { run, logs } = await handler(async () => "fixture-session");
  assert.deepEqual(await run({ sender: {} }, { target: { kind: "wsl" } }), {
    success: true,
    sessionId: "fixture-session",
  });
  assert.deepEqual(logs, []);
});
