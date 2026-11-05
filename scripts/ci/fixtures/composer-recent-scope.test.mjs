import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  acceptComposerRecentReceipt,
  captureComposerRecentSubmission,
  prepareComposerRecentReceipt,
  readComposerRecent,
} from "../../../packages/ui/src/lib/composerRecent.ts";
import { resolveComposerScope } from "../../../packages/ui/src/v4/composer/composerDraftStore.ts";
import { initializeNewTaskDraft } from "../../../packages/ui/src/v4/composer/newTaskDraft.ts";
import { PendingCommandRegistry } from "../../../packages/ui/src/v4/pendingCommandRegistry.ts";
import { loadComponentCallback } from "./component-callback.mjs";

// 全部偏好、导航与权威响应均为内存合成数据；不启动真实 Host/Agent 或访问用户存储。
const originalWindow = globalThis.window;
afterEach(() => {
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
});
const first = {
  providerId: "fixture-provider",
  modelId: "first",
  options: { reasoningLevel: "high" },
};
const second = { ...first, modelId: "second", options: { reasoningLevel: "low" } };
const view = {
  preferredSelection: first,
  providers: [
    {
      providerId: first.providerId,
      models: ["first", "second"].map((modelId) => ({
        modelId,
        config: { optionSpecs: { reasoningLevel: { values: ["low", "high"] } } },
      })),
    },
  ],
};
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
async function fixture(overrides = {}) {
  const records = new Map();
  const storage = {
    getItem: (key) => records.get(key) ?? null,
    setItem: (key, value) => records.set(key, value),
    removeItem: (key) => records.delete(key),
  };
  globalThis.window = { localStorage: storage };
  const registry = new PendingCommandRegistry({ storage });
  const envelopes = [],
    lookups = [];
  let counter = 0;
  const submissionConfigFromCommand = await loadComponentCallback(
    "packages/ui/src/v4/SessionPane.tsx",
    "submissionConfigFromCommand",
    {},
  );
  const context = {
    sessionId: null,
    workspacePath: "fixture-workspace",
    workspaceIdentity: undefined,
    clientNamespace: "desktop",
    rootSessionId: undefined,
    selectionSideChat: false,
    lease: null,
    useZCodeSessionStore: {
      getState: () => ({ getWorkspaceState: () => ({ draftProjectId: "project-p" }) }),
    },
    resolveComposerScope,
    prepareComposerRecentReceipt,
    acceptComposerRecentReceipt,
    captureComposerRecentSubmission,
    baseWorkspaceServices: {
      projectService: {
        resolveSessionDirectories: async (task, hostId) => {
          lookups.push({ task, hostId });
          return { projectId: "project-p" };
        },
      },
    },
    submissionConfigFromCommand,
    readGenUiModelContext: async () => "",
    captureAcceptedModelSelection: () => () => {},
    createCommandEnvelope: (params) => ({
      ...params,
      commandId: `fixture-command-${++counter}`,
      clientId: "fixture-client",
      issuedAt: Date.now(),
    }),
    pendingCommandRegistry: registry,
    measureOperation: (_kind, action) => action(),
    sendCommand: async (envelope) => {
      envelopes.push(envelope);
      return {
        commandId: envelope.commandId,
        status: "accepted",
        result:
          envelope.type === "createSession"
            ? { type: "createSession", sessionId: "created" }
            : undefined,
      };
    },
    handleDraftSessionCreated: async () => {},
    recordV4CommandAck() {},
    shouldResyncForStaleAuthority: () => false,
    isProviderNotReadyError: () => false,
    logger: { warn() {} },
    ...overrides,
  };
  const dispatch = await loadComponentCallback(
    "packages/ui/src/v4/SessionPane.tsx",
    "dispatchCommand",
    context,
  );
  const scope = resolveComposerScope(
    "project-p",
    context.workspaceIdentity,
    context.clientNamespace,
  );
  const recent = (target = scope) =>
    readComposerRecent(context.workspacePath, context.workspaceIdentity, storage, target);
  const newDraft = (target = scope) =>
    initializeNewTaskDraft(
      { text: "", updatedAt: 0 },
      context.workspacePath,
      context.workspaceIdentity,
      view,
      target,
    );
  const send = (modelSelection = second, mode = "guarded", target = context.sessionId) =>
    dispatch("sendText", { text: "E2E_COMPOSER_RECENT_SCOPE", modelSelection, mode }, target);
  return {
    dispatch,
    send,
    registry,
    records,
    storage,
    recent,
    newDraft,
    scope,
    envelopes,
    lookups,
  };
}

test("CR01: 首发第二个模型与自主模式后，新任务继承完整元组", async () => {
  const f = await fixture();
  await f.send();
  assert.deepEqual(f.recent(), { modelSelection: second, mode: "guarded" });
  assert.deepEqual(f.newDraft().modelSelection, second);
  assert.equal(f.newDraft().mode, "guarded");
  assert.equal(
    [...f.records.keys()].some((key) => key.startsWith("zcode-model-selection-recent-v1:")),
    false,
  );
});
test("CR01: createSession 首输入保留点击时项目，预热不写偏好", async () => {
  const f = await fixture();
  await f.dispatch("createSession", { config: { modelSelection: second, mode: "guarded" } }, null);
  assert.equal(f.recent(), null);
  await f.dispatch(
    "createSession",
    { firstInput: { text: "fixture", modelSelection: second, mode: "guarded" } },
    null,
    undefined,
    undefined,
    undefined,
    undefined,
    { projectId: "project-p", taskGroupId: "group-p" },
  );
  assert.deepEqual(f.recent(), { modelSelection: second, mode: "guarded" });
});
test("CR02: 已有会话真实项目优先于当前新建导航项目", async () => {
  const f = await fixture({
    sessionId: "session-p",
    useZCodeSessionStore: {
      getState: () => ({ getWorkspaceState: () => ({ draftProjectId: "project-q" }) }),
    },
  });
  await f.send();
  assert.deepEqual(f.recent(), { modelSelection: second, mode: "guarded" });
  assert.equal(f.recent({ ...f.scope, projectId: "project-q" }), null);
  assert.equal(f.lookups[0].task.taskId, "session-p");
  assert.equal(f.envelopes[0].sessionId, "session-p");
});
for (const status of ["accepted", "duplicate"])
  test(`CR03: 丢 ACK 后刷新账本，query ${status} 恢复偏好`, async () => {
    const f = await fixture({
      sessionId: "session-p",
      sendCommand: async () => {
        throw Error("fixture transport");
      },
    });
    await assert.rejects(f.send());
    assert.equal(f.recent(), null);
    const restored = new PendingCommandRegistry({ storage: f.storage });
    const [entry] = restored.list("session-p");
    assert.ok(entry.clientContext?.composer, "上行前必须持久登记回执");
    restored.applyQuery({
      results: [
        { key: { sessionId: entry.sessionId, commandId: entry.commandId }, result: { status } },
      ],
    });
    assert.deepEqual(f.recent(), { modelSelection: second, mode: "guarded" });
  });
test("CR03: 权威 queue snapshot 确认原命令时更新偏好，不重放", async () => {
  const f = await fixture({
    sessionId: "session-p",
    sendCommand: async () => {
      throw Error("fixture transport");
    },
  });
  await assert.rejects(f.send());
  const restored = new PendingCommandRegistry({ storage: f.storage });
  const [entry] = restored.list("session-p");
  restored.reconcileSnapshot(
    {
      sessionId: "session-p",
      queue: { items: [{ sourceCommandId: entry.commandId }] },
      timeline: [],
    },
    "fixture-workspace",
  );
  assert.deepEqual(f.recent(), { modelSelection: second, mode: "guarded" });
  assert.equal(restored.list("session-p").length, 0);
});
test("CR04: 慢项目查询的早发提交不能覆盖后发已接纳提交", async () => {
  const gate = deferred(),
    entered = deferred();
  let calls = 0;
  const f = await fixture({
    sessionId: "session-p",
    baseWorkspaceServices: {
      projectService: {
        resolveSessionDirectories: async () => {
          if (++calls === 1) {
            entered.resolve();
            await gate.promise;
          }
          return { projectId: "project-p" };
        },
      },
    },
  });
  const early = f.send(first, "build");
  await entered.promise;
  await f.send(second, "guarded");
  gate.resolve();
  await early;
  assert.deepEqual(f.recent(), { modelSelection: second, mode: "guarded" });
});
test("CR04: 查询前冻结提交，晚到旧 ACK 不读取后续菜单编辑", async () => {
  const gate = deferred(),
    entered = deferred();
  const f = await fixture({
    readGenUiModelContext: async () => {
      entered.resolve();
      await gate.promise;
      return "";
    },
  });
  const input = { text: "fixture", modelSelection: structuredClone(second), mode: "guarded" };
  const flight = f.dispatch("sendText", input, null);
  await entered.promise;
  input.modelSelection.modelId = "first";
  input.mode = "build";
  gate.resolve();
  await flight;
  assert.deepEqual(f.recent(), { modelSelection: second, mode: "guarded" });
});
for (const status of ["failed", "rejected"])
  test(`CR05: ${status} 发送不更新默认值`, async () => {
    const f = await fixture({ sendCommand: async () => ({ status }) });
    await f.send();
    assert.equal(f.recent(), null);
  });
test("CR05: Host 归属查询失败不静默写到草稿项目", async () => {
  let sent = false;
  const f = await fixture({
    sessionId: "session-p",
    baseWorkspaceServices: {
      projectService: {
        resolveSessionDirectories: async () => {
          throw Error("fixture project missing");
        },
      },
    },
    sendCommand: async () => {
      sent = true;
      return { status: "accepted" };
    },
  });
  await assert.rejects(f.send());
  assert.equal(sent, false);
  assert.equal(f.recent(), null);
});
for (const auxiliary of [true, false])
  test(`CR06: ${auxiliary ? "辅助 child 查 root" : "普通 fork 查自身"}，上行仍发当前 session`, async () => {
    const f = await fixture({
      sessionId: "child",
      rootSessionId: "parent",
      selectionSideChat: auxiliary,
    });
    await f.send();
    assert.equal(f.lookups[0].task.taskId, auxiliary ? "parent" : "child");
    assert.equal(f.envelopes[0].sessionId, "child");
  });
test("CR07: 客户端与目标 Host 隔离，未归类任务可继承", async () => {
  const f = await fixture({
    clientNamespace: "mobile-fixture",
    workspaceIdentity: "remote:server:fixture-host:/workspace",
    useZCodeSessionStore: {
      getState: () => ({ getWorkspaceState: () => ({ draftProjectId: null }) }),
    },
  });
  const scope = resolveComposerScope(
    null,
    "remote:server:fixture-host:/workspace",
    "mobile-fixture",
  );
  await f.send();
  assert.equal(f.recent(scope)?.mode, "guarded");
  assert.equal(f.recent({ ...scope, clientNamespace: "desktop" }), null);
  assert.equal(f.recent({ ...scope, hostId: "other-host" }), null);
});
test("CR08: 全新任务不继承 Plan 开关", async () => {
  const f = await fixture();
  await f.send(second, "plan");
  assert.equal(f.newDraft().mode, "build");
  assert.equal(f.newDraft().planEnabled, false);
});
test("CR04: 手动重发保留原 scope/order，不成为新的偏好", async () => {
  const f = await fixture({ sessionId: "session-p" });
  const older = prepareComposerRecentReceipt(f.scope, { modelSelection: first, mode: "build" });
  await f.send();
  await f.dispatch(
    "sendText",
    { text: "fixture retry", modelSelection: first, mode: "build" },
    "session-p",
    undefined,
    undefined,
    undefined,
    undefined,
    { composer: older },
  );
  assert.deepEqual(f.recent(), { modelSelection: second, mode: "guarded" });
});
for (const type of ["retryTurn", "editUserQuery"])
  test(`CR05: ${type} 未登记可重发输入，仍保留原接纳偏好行为`, async () => {
    const f = await fixture({ sessionId: "session-p" });
    await f.dispatch(type, { modelSelection: second, mode: "guarded" }, "session-p");
    assert.deepEqual(f.recent(), { modelSelection: second, mode: "guarded" });
  });

for (const projectId of ["project-p", null])
  test(`CR09: E2E 预置写当前项目 ${projectId} 的 v2 key，保留权限与接纳顺序`, async () => {
    const f = await fixture();
    const targetScope = resolveComposerScope(projectId);
    acceptComposerRecentReceipt(
      prepareComposerRecentReceipt(targetScope, { modelSelection: second, mode: "guarded" }),
      f.storage,
    );
    const key = `zcode-composer-recent:v2:${JSON.stringify(["desktop", "local", projectId])}`;
    const order = JSON.parse(f.records.get(key)).order;
    globalThis.window.__zcodeSessionStoreE2E = {
      getState: () => ({ workspaces: { "fixture-workspace": { draftProjectId: projectId } } }),
    };
    const seed = await loadComponentCallback(
      "packages/desktop/test/e2e/helpers/upstream-provider.ts",
      "seedUpstreamToolbarPreferences",
      {
        browser: { execute: (action, ...args) => action(...args) },
        DEFAULT_WORKSPACE: "fixture-workspace",
        UPSTREAM_PROVIDER_ID: first.providerId,
        UPSTREAM_MODEL: first.modelId,
        UPSTREAM_THOUGHT_LEVEL: "high",
        MODEL_SELECTION_RECENT_KEY_PREFIX: "zcode-model-selection-recent-v1",
        ZCODE_AGENT_PROVIDER: "fixture-agent",
      },
    );
    await seed();
    assert.deepEqual(f.recent(targetScope), { modelSelection: first, mode: "guarded" });
    assert.equal(JSON.parse(f.records.get(key)).order, order);
    assert.equal(f.recent({ ...targetScope, projectId: "project-q" }), null);
    assert.equal(
      [...f.records.keys()].some((key) => key.startsWith("zcode-model-selection-recent-v1:")),
      false,
    );
  });

test("CR09: E2E 诊断同时采集 v2 与历史 key，不遗漏实际偏好", async () => {
  const entries = {
    'zcode-composer-recent:v2:["desktop","local","project-p"]': "fixture-v2",
    "zcode-model-selection-recent-v1:fixture-workspace": "fixture-legacy",
    "unrelated-key": "fixture-other",
  };
  globalThis.window = { localStorage: entries };
  const readSnapshot = await loadComponentCallback(
    "packages/desktop/test/e2e/helpers/conversation-session-store-snapshot-script.ts",
    "readTaskStoreSnapshotInBrowser",
    {},
  );
  const { snapshot } = readSnapshot("fixture-session");
  assert.deepEqual(snapshot.lastSelectedModelStorage, {
    'zcode-composer-recent:v2:["desktop","local","project-p"]': "fixture-v2",
    "zcode-model-selection-recent-v1:fixture-workspace": "fixture-legacy",
  });
});
