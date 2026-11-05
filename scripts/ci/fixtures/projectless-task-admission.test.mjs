import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  bindPendingTaskDraft,
  ensurePendingTaskDraft,
  persistV4ComposerDraft,
  readPendingTaskDraft,
  readV4ComposerDraft,
  resolveComposerScope,
  V4_DRAFT_SCOPE_ROOT,
} from "../../../packages/ui/src/v4/composer/composerDraftStore.ts";
import { readComposerRecent } from "../../../packages/ui/src/lib/composerRecent.ts";
import { PendingCommandRegistry } from "../../../packages/ui/src/v4/pendingCommandRegistry.ts";
import { createProjectlessAdmission } from "./projectless-task-admission.mjs";

const originalWindow = globalThis.window;
afterEach(() => {
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
});
const scope = resolveComposerScope(null);
const selection = {
  providerId: "fixture-provider",
  modelId: "fixture-model",
  options: { reasoningLevel: "high" },
};
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(options = {}) {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  globalThis.window = { localStorage: storage };
  const pending = ensurePendingTaskDraft(scope);
  const path = `fixture-workspace/draft-${pending.draftId}`;
  bindPendingTaskDraft(scope, pending.draftId, path);
  const persist = (text) =>
    persistV4ComposerDraft(
      path,
      undefined,
      V4_DRAFT_SCOPE_ROOT,
      {
        text,
        mode: "guarded",
        modelSelection: selection,
      },
      scope,
    );
  persist("first input");
  const admission = await createProjectlessAdmission({
    workspacePath: path,
    selection,
    ...options,
  });
  return {
    ...admission,
    storage,
    path,
    pending,
    persist,
    recent: () => readComposerRecent(path, undefined, storage, scope),
  };
}
for (const [name, options, text, types] of [
  ["预热 sendText", {}, "first input", ["sendText"]],
  ["现场 createSession.firstInput", { prewarm: false }, "first input", ["createSession"]],
  [
    "现场空会话后附件 sendText",
    { prewarm: false, attachments: true },
    "first input",
    ["createSession", "sendText"],
  ],
  [
    "现场空会话后 Goal",
    { prewarm: false },
    "/goal first input",
    ["createSession", "sendGoalCommand"],
  ],
])
  test(`PTW02: ${name} 的实际输入接纳交接目录与完整选择`, async () => {
    const f = await fixture(options);
    await f.send(
      text,
      options.attachments ? { attachments: [{ id: "fixture-attachment" }] } : undefined,
    );
    assert.deepEqual(
      f.envelopes.map((item) => item.type),
      types,
    );
    assert.equal(readPendingTaskDraft(scope), null);
    assert.deepEqual(f.recent(), { modelSelection: selection, mode: "guarded" });
    assert.notEqual(ensurePendingTaskDraft(scope).draftId, f.pending.draftId);
  });

test("PTW02: 空 create ACK 不提前消费目录、偏好或提升页面，拒绝首输入保留草稿", async () => {
  let f;
  f = await fixture({
    prewarm: false,
    sendCommand: async (envelope) => {
      assert.equal(readPendingTaskDraft(scope).draftId, f.pending.draftId);
      assert.equal(f.recent(), null);
      assert.deepEqual(f.created, []);
      if (envelope.type === "createSession")
        return {
          commandId: envelope.commandId,
          status: "accepted",
          result: { type: "createSession", sessionId: "fixture-created-session" },
        };
      return { commandId: envelope.commandId, status: "rejected", reasonCode: "fixture-rejected" };
    },
  });
  await assert.rejects(f.send("first input", { attachments: [{ id: "fixture-attachment" }] }));
  assert.equal(readPendingTaskDraft(scope).draftId, f.pending.draftId);
  assert.equal(readPendingTaskDraft(scope).commandId, undefined);
  assert.equal(f.recent(), null);
  assert.equal(
    readV4ComposerDraft(f.path, undefined, V4_DRAFT_SCOPE_ROOT, scope).text,
    "first input",
  );
});

test("PTW02: Host 在 admission 前拒绝时释放发送标记，原草稿可以重试", async () => {
  let attempts = 0;
  const f = await fixture({
    isProviderNotReadyError: (error) => error.message === "fixture-provider-not-ready",
    sendCommand: async (envelope) => {
      if (++attempts === 1) throw Error("fixture-provider-not-ready");
      return { commandId: envelope.commandId, status: "accepted" };
    },
  });
  assert.equal(await f.send("first input"), "blocked");
  assert.equal(readPendingTaskDraft(scope).draftId, f.pending.draftId);
  assert.equal(readPendingTaskDraft(scope).commandId, undefined);
  assert.equal(f.recent(), null);
  await f.send("first input");
  assert.equal(readPendingTaskDraft(scope), null);
  assert.equal(f.envelopes.length, 2);
});

for (const status of ["accepted", "duplicate"])
  test(`PTW02: 传输结果未知后刷新，query ${status} 交接原首发且不重发`, async () => {
    const f = await fixture({
      prewarm: false,
      sendCommand: async () => {
        throw Error("fixture transport");
      },
    });
    await assert.rejects(f.send("first input"));
    assert.equal(readPendingTaskDraft(scope).draftId, f.pending.draftId);
    const restored = new PendingCommandRegistry({ storage: f.storage });
    const [entry] = restored.list(null);
    assert.equal(entry.clientContext.composer.draftId, f.pending.draftId);
    restored.applyQuery({
      results: [
        {
          key: { sessionId: null, commandId: entry.commandId },
          result: {
            status,
            result: { type: "createSession", sessionId: "fixture-created-session" },
          },
        },
      ],
    });
    assert.equal(readPendingTaskDraft(scope), null);
    assert.deepEqual(f.recent(), { modelSelection: selection, mode: "guarded" });
    assert.equal(f.envelopes.length, 1);
  });

test("PTW02: 权威快照先于 ACK 交接首发，将等待期间新正文保留给正式 session", async () => {
  let f;
  f = await fixture({
    prewarm: false,
    sendCommand: async (envelope, registry) => {
      f.persist("next input while waiting");
      registry.reconcileSnapshot(
        {
          sessionId: "fixture-created-session",
          queue: { items: [{ sourceCommandId: envelope.commandId }] },
          rows: { window: [] },
        },
        f.path,
      );
      return {
        commandId: envelope.commandId,
        status: "accepted",
        result: { type: "createSession", sessionId: "fixture-created-session" },
      };
    },
  });
  await f.send("first input");
  assert.equal(readPendingTaskDraft(scope), null);
  assert.equal(readV4ComposerDraft(f.path, undefined, V4_DRAFT_SCOPE_ROOT, scope), null);
  assert.equal(
    readV4ComposerDraft(f.path, undefined, "fixture-created-session").text,
    "next input while waiting",
  );
  assert.deepEqual(f.created, ["fixture-created-session"]);
});

test("PTW02: 配置屏障前冻结身份，迟到旧输入不消费新 draftId", async () => {
  const gate = deferred();
  const f = await fixture({ barrier: { enqueue: (action) => gate.promise.then(action) } });
  const sent = f.send("first input");
  // 模拟另一入口切换了组织草稿代际；旧回执必须沿用点击时的原身份。
  f.storage.removeItem(`zcode-pending-task-draft:v1:${JSON.stringify(["desktop", "local", null])}`);
  const next = ensurePendingTaskDraft(scope);
  bindPendingTaskDraft(scope, next.draftId, "fixture-next-workspace");
  gate.resolve();
  await sent;
  assert.equal(
    f.registry.list("fixture-prewarm-session")[0].clientContext.composer.draftId,
    f.pending.draftId,
  );
  assert.equal(readPendingTaskDraft(scope).draftId, next.draftId);
});
