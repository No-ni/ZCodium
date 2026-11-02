import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";
import { loadComponentCallback } from "./fixtures/component-callback.mjs";
const { PendingCommandRegistry } = await tsImport(
  "../../packages/ui/src/v4/pendingCommandRegistry.ts",
  {
    parentURL: import.meta.url,
    // Registry 拆分后使用 UI 包别名；入口显式读取该包配置，避免依赖调用方的 tsx 环境。
    tsconfig: fileURLToPath(new URL("../../packages/ui/tsconfig.json", import.meta.url)),
  },
);
const context = {
  workspace: { workspacePath: "fixture", workspaceIdentity: "identity-a" },
  projectId: "project-a",
  taskGroupId: "group-a",
};
const ack = { status: "accepted", result: { type: "createSession", sessionId: "created" } };
function registry() {
  const values = new Map();
  return new PendingCommandRegistry({
    storage: {
      getItem: (k) => values.get(k) ?? null,
      setItem: (k, v) => values.set(k, v),
      removeItem: (k) => values.delete(k),
    },
  });
}
function snapshot(commandId = "creation-a") {
  return {
    sessionId: "created",
    queue: { items: [] },
    rows: { window: [{ kind: "userInput", sourceCommandId: commandId }] },
  };
}
async function dispatch(reg, send, completed) {
  return loadComponentCallback("packages/ui/src/v4/SessionPane.tsx", "dispatchCommand", {
    sessionId: null,
    workspacePath: "fixture",
    workspaceIdentity: "identity-a",
    lease: null,
    useZCodeSessionStore: { getState: () => ({ getWorkspaceState: () => ({}) }) },
    readGenUiModelContext: async () => "",
    submissionConfigFromCommand: () => null,
    captureComposerRecentSubmission() {},
    captureAcceptedModelSelection() {},
    createCommandEnvelope: (params) => ({
      ...params,
      commandId: "creation-a",
      clientId: "fixture-client",
      issuedAt: Date.now(),
    }),
    pendingCommandRegistry: reg,
    handleDraftSessionCreated: async (...args) => completed.push(args),
    measureOperation: (_kind, callback) => callback(),
    sendCommand: send,
    recordV4CommandAck() {},
    shouldResyncForStaleAuthority: () => false,
    isProviderNotReadyError: () => false,
    logger: { warn() {} },
  });
}
const create = (callback) =>
  callback(
    "createSession",
    { workspaceId: "identity-a", firstInput: { text: "fixture" } },
    null,
    undefined,
    undefined,
    undefined,
    undefined,
    context,
  );

test("normal ACK, duplicate ACK and later projection complete one creation", async () => {
  const reg = registry(),
    completed = [];
  await create(await dispatch(reg, async () => ack, completed));
  reg.applyAck({ sessionId: "created", commandId: "creation-a" }, { ...ack, status: "duplicate" });
  reg.reconcileSnapshot(snapshot(), "identity-a");
  assert.equal(completed.length, 1);
  assert.equal(completed[0][0], "created");
  assert.deepEqual(completed[0][1], context);
});

test("lost ACK resolves through actual registry query once", async () => {
  const reg = registry(),
    completed = [];
  await assert.rejects(
    create(
      await dispatch(
        reg,
        async () => {
          throw Error("fixture transport");
        },
        completed,
      ),
    ),
  );
  reg.applyQuery({ results: [{ key: { sessionId: null, commandId: "creation-a" }, result: ack }] });
  reg.reconcileSnapshot(snapshot(), "identity-a");
  assert.equal(completed.length, 1);
  assert.equal(completed[0][0], "created");
});

test("projection before ACK binds original creation before notifying completion", async () => {
  const reg = registry(),
    completed = [];
  await create(
    await dispatch(
      reg,
      async () => {
        reg.reconcileSnapshot(snapshot(), "identity-a");
        assert.equal(completed.length, 1);
        return ack;
      },
      completed,
    ),
  );
  assert.equal(completed.length, 1);
  assert.equal(completed[0][0], "created");
});

test("another workspace projection cannot consume creation resolution", async () => {
  const reg = registry(),
    completed = [];
  await create(
    await dispatch(
      reg,
      async () => {
        reg.reconcileSnapshot(snapshot(), "identity-b");
        assert.equal(completed.length, 0);
        return ack;
      },
      completed,
    ),
  );
  assert.equal(completed.length, 1);
});
