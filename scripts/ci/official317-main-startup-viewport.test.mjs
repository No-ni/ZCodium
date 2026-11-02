import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";
import { createProjectTestSandbox, assertProjectPath } from "./project-test-sandbox.mjs";
import { resolveStartupWindowBootstrap } from "../../packages/desktop/src/main/startupWorkspace.ts";

test("startup warms exactly the active local session from the canonical persisted list", async () => {
  const sandbox = await createProjectTestSandbox("main-startup");
  const a = await assertProjectPath(join(sandbox.root, "workspace-a"));
  const b = await assertProjectPath(join(sandbox.root, "workspace-b"));
  await mkdir(a);
  await mkdir(b);
  const settingsFile = join(sandbox.root, "settings.json");
  await writeFile(
    settingsFile,
    JSON.stringify({
      lastWorkspaceSession: [
        { kind: "local", workspacePath: a },
        { kind: "local", workspacePath: b },
      ],
      lastActiveTabIndex: 1,
    }),
  );
  const result = await resolveStartupWindowBootstrap({
    settingsFile,
    conversationWorkspaceDir: join(sandbox.root, "backing"),
  });
  assert.deepEqual(result.agentWarmupTargets, [{ workspacePath: b }]);
});

test("viewport IPC forwards the actual sender zoom and validated viewport to its window owner", async () => {
  const source = await readFile(
    new URL("../../packages/desktop/src/main/desktopBrowserViewIpc.ts", import.meta.url),
    "utf8",
  );
  const file = ts.createSourceFile("ipc.ts", source, ts.ScriptTarget.Latest, true);
  let callback;
  function visit(n) {
    if (
      ts.isCallExpression(n) &&
      n.expression.getText(file) === "ipcMain.handle" &&
      n.arguments[0]?.getText(file) === "PlatformChannels.BrowserViewUpdateViewport"
    )
      callback = n.arguments[1];
    ts.forEachChild(n, visit);
  }
  visit(file);
  assert.ok(callback);
  const js = ts.transpileModule(
    "const callback = " + callback.getText(file) + "; return callback;",
    { compilerOptions: { target: ts.ScriptTarget.ESNext } },
  ).outputText;
  const calls = [];
  const deps = {
    BrowserWindow: { fromWebContents: () => ({ id: 7, isDestroyed: () => false }) },
    nonEmptyStringSchema: { parse: (x) => x },
    browserViewportInputSchema: { parse: (x) => x },
    updateBrowserGuestViewport: (...args) => calls.push(args),
  };
  const fn = new Function(...Object.keys(deps), js)(...Object.values(deps));
  const viewport = { width: 800, height: 600 };
  await fn({ sender: { getZoomFactor: () => 1.5 } }, { tabId: "tab-a", viewport });
  assert.deepEqual(calls, [["tab-a", viewport, 7, 1.5]]);
  deps.BrowserWindow.fromWebContents = () => undefined;
  await fn(
    {
      sender: {
        getZoomFactor: () => {
          throw Error("retired sender");
        },
      },
    },
    { tabId: "tab-a", viewport },
  );
  assert.equal(calls.length, 1);
});
