import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function parsed(path) {
  return ts.createSourceFile(path, await readFile(path, "utf8"), ts.ScriptTarget.Latest, true);
}
function executable(source, node, dependencies) {
  const { outputText } = ts.transpileModule(`const run = ${node.getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ESNext },
  });
  return new Function(...Object.keys(dependencies), `${outputText}; return run;`)(
    ...Object.values(dependencies),
  );
}
async function configEffect(port) {
  const source = await parsed(
    "packages/ui/src/workspace-config-catalog/useConfigWorkspaceServices.ts",
  );
  let effect;
  function visit(node) {
    if (!effect && ts.isCallExpression(node) && node.expression.getText(source) === "useEffect")
      effect = node.arguments[0];
    ts.forEachChild(node, visit);
  }
  visit(source);
  const published = [],
    logged = [];
  const services = { sourceServerWorkspaceService: port };
  const run = executable(source, effect, {
    workspace: { rpcReady: false },
    canAttach: true,
    sourceServices: services,
    workspacePath: "/fixture",
    workspaceKey: "source-a",
    legacyRouteHint: "legacy-a",
    setBinding: (value) => published.push(value),
    logger: { error: (...values) => logged.push(values) },
  });
  return { cleanup: run(), published, logged, services };
}

test("missing Source configuration port never admits workspace writes", async () => {
  const result = await configEffect(undefined);
  assert.deepEqual(result.published, []);
  assert.equal(result.cleanup, undefined);
});

test("late alias admission cannot publish after its attachment is retired", async () => {
  let accept;
  const calls = [];
  const result = await configEffect({
    resolveWorkspace: (input) => {
      calls.push(input);
      return new Promise((resolve) => {
        accept = resolve;
      });
    },
  });
  assert.deepEqual(calls, [{ workspacePath: "/fixture", legacyRouteHint: "legacy-a" }]);
  result.cleanup();
  accept();
  await Promise.resolve();
  assert.deepEqual(result.published, []);
});

test("user config sync requires its actual channel and preserves category on every call", async () => {
  const source = await parsed("packages/ui/src/data-sync/app/categories.ts");
  const node = source.statements.find(
    (statement) =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === "bindUserConfigSyncCategory",
  );
  const bind = executable(source, node, {});
  assert.throws(() => bind({}, "hooks"), /user-config-sync\.service-unavailable/);
  const calls = [];
  const channel = Object.fromEntries(
    [
      "listSyncItems",
      "getSyncContentHashes",
      "checkSyncWriteAccess",
      "exportSyncItems",
      "importSyncItems",
    ].map((name) => [
      name,
      (input) => {
        calls.push([name, input]);
        return Promise.resolve({});
      },
    ]),
  );
  const bound = bind({ userConfigSyncService: channel }, "hooks");
  await bound.listSyncItems();
  await bound.exportSyncItems({ keys: ["fixture"] });
  assert.deepEqual(calls, [
    ["listSyncItems", { category: "hooks" }],
    ["exportSyncItems", { category: "hooks", keys: ["fixture"] }],
  ]);
});
