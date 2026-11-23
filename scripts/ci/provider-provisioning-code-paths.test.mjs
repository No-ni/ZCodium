import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";
import { tsImport } from "tsx/esm/api";

const shared = await tsImport("../../packages/shared/src/index.ts", import.meta.url);
const executorSource = await readFile(
  new URL("../../packages/desktop/src/host/remoteProviderProvisioningService.ts", import.meta.url),
  "utf8",
);
const compiled = ts.transpileModule(executorSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const module = { exports: {} };
new Function(
  "require",
  "exports",
  "module",
  compiled + "\nexports.fixtureFactory = createRemoteProviderProvisioningExecutor;",
)(
  (id) => {
    if (id === "@zcode/shared") return shared;
    if (id === "node:crypto") return { randomUUID: () => "synthetic-sync" };
    assert.equal(id, "@zcode/services/node");
    return {};
  },
  module.exports,
  module,
);
const createExecutor = module.exports.fixtureFactory;
const envelope = { schemaVersion: 2, syncId: "synthetic-sync", personalConfig: {} };
const source = { read: async () => envelope };
const result = (status = "failed", errorCode) => ({
  syncId: "synthetic-sync",
  status,
  personalProviderCount: 0,
  rolledBack: status === "failed",
  ...(errorCode ? { errorCode } : {}),
});

test("executor preserves known target stages, rejects unknown stages and strips successful diagnostics", async () => {
  for (const [status, remoteCode, expected] of [
    ["failed", "target-refresh-failed", "target-refresh-failed"],
    ["rollback_failed", "target-write-failed", "target-write-failed"],
    ["failed", "synthetic-private-stage", "target-apply-failed"],
    ["failed", undefined, "target-apply-failed"],
    ["applied", "synthetic-private-stage", undefined],
    ["already-applied", "target-write-failed", undefined],
  ]) {
    const executor = createExecutor({
      source,
      target: { apply: async () => result(status, remoteCode) },
    });
    const actual = await executor.syncLocalToRemote();
    assert.equal(actual.status, status);
    assert.equal(actual.errorCode, expected);
    assert.equal("credentialCount" in actual, false);
  }
});

test("executor reports source, target-call and authorization failures without copying private errors", async () => {
  const cases = [
    {
      options: {
        source: {
          read: async () => {
            throw new Error("synthetic-private-source");
          },
        },
        target: {},
      },
      expected: "source-read-failed",
    },
    {
      options: {
        source,
        target: {
          apply: async () => {
            throw new Error("synthetic-private-target");
          },
        },
      },
      expected: "target-call-failed",
    },
    {
      options: { source, target: {} },
      authorize: async () => {
        throw new Error("synthetic-private-authorization");
      },
      expected: "host-execution-failed",
    },
    { options: {}, expected: "capability-unavailable" },
  ];
  for (const item of cases) {
    const actual = await createExecutor(item.options).syncLocalToRemote(item.authorize);
    assert.equal(actual.errorCode, item.expected);
    assert.doesNotMatch(actual.errorMessage, /synthetic-private/);
  }
  let assertions = 0;
  let applied = false;
  const executor = createExecutor({
    source,
    target: {
      apply: async () => {
        applied = true;
        return result("applied");
      },
    },
  });
  const actual = await executor.syncLocalToRemote(async () => {
    if (++assertions === 2) throw new Error("synthetic-private-revocation");
  });
  assert.equal(actual.errorCode, "host-execution-failed");
  assert.equal(applied, false);
});

const hostSource = await readFile(
  new URL("../../packages/desktop/src/host/index.ts", import.meta.url),
  "utf8",
);
const hostFile = ts.createSourceFile("index.ts", hostSource, ts.ScriptTarget.Latest, true);
const branches = [];
function visit(node) {
  if (
    ts.isIfStatement(node) &&
    node.expression.getText(hostFile) ===
      "msg.type === HostMessageTypes.ProviderProvisioningExecute"
  )
    branches.push(node.thenStatement.getText(hostFile));
  ts.forEachChild(node, visit);
}
visit(hostFile);
assert.equal(branches.length, 1);
const handlerCode = ts.transpileModule(`function handle(msg) ${branches[0]}`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function hostFixture({ reply = result(), sessionPresent = true, denied = false } = {}) {
  let resolve;
  const response = new Promise((done) => {
    resolve = done;
  });
  let authorizations = 0;
  const dependencies = {
    HostMessageTypes: shared.HostMessageTypes,
    HostResponseTypes: shared.HostResponseTypes,
    parentPort: { postMessage: resolve },
    buildRemoteEnvironmentKey: () => {
      throw new Error("Unexpected identity fallback");
    },
    windowRemoteConnectionRegistry: {
      getSession: () =>
        sessionPresent
          ? {
              remoteSessionId: "remote",
              sourceServerId: "source",
              workspaceIdentity: "remote-identity",
              workspacePath: "/synthetic",
            }
          : undefined,
      assertProviderProvisioningAllowed: async () => {
        authorizations++;
        if (denied) throw new Error("synthetic-private-denial");
      },
      resolveScopedServices: () => ({}),
    },
    getRemoteProviderProvisioningExecutor: () => ({
      syncLocalToRemote: async (authorize) => {
        await authorize();
        return reply;
      },
    }),
  };
  const handle = new Function(...Object.keys(dependencies), handlerCode + "\nreturn handle;")(
    ...Object.values(dependencies),
  );
  handle({
    type: shared.HostMessageTypes.ProviderProvisioningExecute,
    remoteSessionId: "remote",
    requestId: "request",
    environmentKey: "source-server:source",
  });
  return { response, authorizations: () => authorizations };
}

test("actual Host branch forwards fixed stages and keeps invalid or denied registration closed", async () => {
  const f = hostFixture({ reply: result("failed", "target-commit-failed") });
  const response = await f.response;
  assert.equal(response.errorCode, "target-commit-failed");
  assert.equal(response.requestId, "request");
  assert.ok(f.authorizations() >= 2);
  const invalid = await hostFixture({ sessionPresent: false }).response;
  assert.equal(invalid.errorCode, "session-unavailable");
  const denied = await hostFixture({ denied: true }).response;
  assert.equal(denied.errorCode, "host-execution-failed");
  assert.doesNotMatch(denied.error, /synthetic-private/);
});
