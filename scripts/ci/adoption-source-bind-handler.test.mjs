import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { tsImport } from "tsx/esm/api";
const shared = await tsImport("../../packages/shared/src/index.ts", import.meta.url);

const message = {
  type: "bind-remote-workspace-context",
  requestId: "fixture-bind",
  remoteSessionId: "fixture-session",
  workspacePath: "/fixture",
  workspaceIdentity: "fixture-identity",
};
const current = {
  ...message,
  state: "online",
  sourceAvailability: "online",
  workspaceReadyState: "ready",
  generation: 2,
};
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function loadHandler(dependencies) {
  const path = new URL("../../packages/desktop/src/host/index.ts", import.meta.url);
  const text = await readFile(path, "utf8");
  const source = ts.createSourceFile(
    "index.ts",
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const matches = [];
  function visit(node) {
    if (
      ts.isIfStatement(node) &&
      node.expression.getText(source) === "msg.type === HostMessageTypes.BindRemoteWorkspaceContext"
    )
      matches.push(node.thenStatement.getText(source));
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal(matches.length, 1);
  const { outputText } = ts.transpileModule(`async function handler() ${matches[0]}`, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  });
  return new Function(...Object.keys(dependencies), `${outputText}; return handler;`)(
    ...Object.values(dependencies),
  );
}
function fixture(options = {}) {
  const barrier = deferred();
  const responses = [];
  let snapshot = { ...current, generation: 1 };
  let shutdown = false;
  let detached = 0;
  const dependencies = {
    msg: message,
    HostResponseTypes: shared.HostResponseTypes,
    windowRemoteConnectionRegistry: {
      getSession: () => snapshot,
      bindWorkspaceContext() {
        if (options.synchronousFailure) throw new Error("raw fixture error");
        snapshot = { ...current };
        return barrier.promise;
      },
    },
    windowHostAttachmentRegistry: {
      detachStaleRemoteSessionAttachments() {
        detached++;
      },
    },
    windowHostControllerRuntime: { removeSource() {} },
    parentPort: {
      postMessage(value) {
        if (options.sendFailure) throw new Error("transport closed");
        responses.push(value);
      },
    },
    logger: { warn() {}, info() {} },
    activeServices: {},
    requestTaskAutoArchiveScan: async () => {
      if (options.archiveFailure) throw new Error("archive failure");
    },
  };
  Object.defineProperty(dependencies, "hasDisposedHostResources", {
    enumerable: true,
    get: () => shutdown,
  });
  return {
    barrier,
    responses,
    dependencies,
    retire() {
      snapshot = { ...current, generation: 3 };
    },
    get detached() {
      return detached;
    },
  };
}

test("correlated Host bind responses are strict and generation-bearing", () => {
  const ready = {
    type: "remote-workspace-context-bind-ready",
    requestId: message.requestId,
    remoteSessionId: message.remoteSessionId,
    workspacePath: message.workspacePath,
    workspaceIdentity: message.workspaceIdentity,
    generation: 2,
  };
  assert.equal(shared.hostResponseMessageSchema.safeParse(ready).success, true);
  for (const bad of [
    { ...ready, generation: 0 },
    { ...ready, secret: "not allowed" },
    { ...ready, workspaceIdentity: "" },
  ])
    assert.equal(shared.hostResponseMessageSchema.safeParse(bad).success, false);
});
test("production Host handler sends ready only after authoritative workspace preparation", async () => {
  const f = fixture({ archiveFailure: true });
  const handler = await loadHandler(f.dependencies);
  await handler();
  assert.equal(f.responses.length, 0);
  assert.equal(f.detached, 1);
  f.barrier.resolve();
  await new Promise((done) => setImmediate(done));
  assert.equal(f.responses.length, 1);
  assert.deepEqual(f.responses[0], {
    type: "remote-workspace-context-bind-ready",
    requestId: message.requestId,
    remoteSessionId: message.remoteSessionId,
    workspacePath: message.workspacePath,
    workspaceIdentity: message.workspaceIdentity,
    generation: 2,
  });
});
for (const synchronousFailure of [true, false])
  test(`production Host handler returns a safe correlated ${synchronousFailure ? "synchronous" : "asynchronous"} failure`, async () => {
    const f = fixture({ synchronousFailure });
    const handler = await loadHandler(f.dependencies);
    await handler();
    if (!synchronousFailure) f.barrier.reject(new Error("raw path/key fixture error"));
    await new Promise((done) => setImmediate(done));
    assert.equal(f.responses.length, 1);
    assert.equal(f.responses[0].type, "remote-workspace-context-bind-failed");
    assert.equal(f.responses[0].requestId, message.requestId);
    assert.equal(f.responses[0].remoteSessionId, message.remoteSessionId);
    assert.equal(f.responses[0].error.includes("raw"), false);
  });
test("production Host handler cannot publish a retired workspace generation", async () => {
  const f = fixture();
  await (
    await loadHandler(f.dependencies)
  )();
  f.retire();
  f.barrier.resolve();
  await new Promise((done) => setImmediate(done));
  assert.equal(f.responses.length, 1);
  assert.equal(f.responses[0].type, "remote-workspace-context-bind-failed");
});
test("production Host response transport failure is consumed without unhandled rejection", async () => {
  const failures = [];
  const observe = (reason) => failures.push(reason);
  process.on("unhandledRejection", observe);
  try {
    const f = fixture({ sendFailure: true });
    await (
      await loadHandler(f.dependencies)
    )();
    f.barrier.resolve();
    await new Promise((done) => setImmediate(done));
    assert.deepEqual(failures, []);
  } finally {
    process.off("unhandledRejection", observe);
  }
});
