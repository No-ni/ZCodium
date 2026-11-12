import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { NativeContextStoreConflictError, SessionEventType } from "@zcode/contracts";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import { nativeContextStatusSchema } from "@zcode/shared/native-context-compression";
import {
  assertProjectPath,
  createProjectTestFixture,
} from "../../../../../scripts/ci/project-test-sandbox.mjs";
import { sessionInput } from "../../adapters/test/fixtures/native-context-store.js";
import { MessageHistoryImpl } from "../src/agent/message-history.js";
import { hydrateMessageHistoryFromSession } from "../src/agent/session-history-hydrator.js";
import { getNativeContextCompression } from "../src/runtime/native-context-compression/controller.js";
import {
  recoverNativeContext,
  resetNativeContextAfterCompact,
} from "../src/runtime/native-context-compression/boundaries.js";
import { nativeOwner, nativeStatus } from "../src/runtime/native-context-compression/state.js";
import {
  compactMessage,
  commit,
  fixture,
  message,
  observation,
  PARENT,
} from "./native-context-boundary-fixture.js";

test("NCTX-02 legacy history without compact initializes manual once and survives a file-backed fresh-owner reopen", async (t) => {
  const messages = [
    message("legacy-user"),
    message("legacy-assistant", "assistant"),
    message("legacy-followup"),
  ];
  messages.forEach((item, index) => {
    item.info.time.created = 10 + index;
  });
  const base = await fixture(t, messages);
  const originalMessages = structuredClone(messages);
  const originalHistory = structuredClone(base.host.messageHistory.borrowReadOnlyRuntimeEntries());
  const directory = await createProjectTestFixture("nctx-legacy-manual-reopen");
  const dbPath = await assertProjectPath(join(directory, "legacy.sqlite"));
  type Store = Awaited<ReturnType<typeof createSqliteSessionStore>>;
  const openStores = new Set<Store>();
  t.after(async () => {
    for (const store of openStores) await store.close();
  });
  const open = async () => {
    const store = await createSqliteSessionStore({ dbPath });
    openStores.add(store);
    return store;
  };
  let modelCalls = 0;
  const freshHost = async (store: Store) => {
    const host = {
      ...base.host,
      sessionStore: store,
      messageHistory: new MessageHistoryImpl(),
      modelFactory: () => {
        modelCalls += 1;
        throw new Error("legacy recovery must not create a model request");
      },
    };
    await hydrateMessageHistoryFromSession({
      history: host.messageHistory,
      messages: await store.messages({ sessionID: PARENT }),
    });
    assert.equal(nativeOwner(host).state, null);
    return host;
  };
  const store = await open();
  await store.createSession(sessionInput(PARENT));
  await store.commitMessageBundle({ sessionID: PARENT, messages });
  assert.equal(
    messages.some((item) => item.parts.some((part) => part.type === "compaction")),
    false,
  );
  assert.equal(await store.getNativeContextState(PARENT), null);
  assert.deepEqual((await store.listNativeContextOperations(PARENT, {})).items, []);
  assert.deepEqual((await store.listNativeContextObservations(PARENT, {})).items, []);
  const emptyUsage = await store.queryTaskUsage({ sessionID: PARENT });
  assert.equal(emptyUsage.modelRequestCount, 0);
  assert.equal(emptyUsage.totalTokens, 0);

  const first = await freshHost(store);
  await recoverNativeContext(first);
  const status = nativeContextStatusSchema.parse(await getNativeContextCompression.call(first));
  const initialized = await store.getNativeContextForkBundle(PARENT);
  assert.ok(initialized);
  assert.equal(status.policy.mode, "manual");
  assert.equal(status.policy.policyVersion, 0);
  assert.equal(status.currentSegmentId, "initial");
  assert.equal(initialized.state.compactBoundaryId, "initial");
  assert.equal(initialized.state.requestSeq, 0);
  assert.equal(status.lastObservation, null);
  assert.equal(status.lastOperation, null);
  assert.deepEqual(initialized.operations, []);
  assert.deepEqual(initialized.observations, []);
  assert.deepEqual(await store.messages({ sessionID: PARENT }), originalMessages);
  assert.deepEqual(first.messageHistory.borrowReadOnlyRuntimeEntries(), originalHistory);

  // 恢复可以合法推进首次 revision；重复读取与新 owner 重开必须保持实际已提交的版本。
  assert.deepEqual(await getNativeContextCompression.call(first), status);
  assert.deepEqual(await store.getNativeContextForkBundle(PARENT), initialized);
  await store.close();
  openStores.delete(store);
  const reopenedStore = await open();
  const reopened = await freshHost(reopenedStore);
  await recoverNativeContext(reopened);
  assert.notEqual(reopened, first);
  assert.notEqual(reopened.messageHistory, first.messageHistory);
  assert.notEqual(nativeOwner(reopened), nativeOwner(first));
  assert.deepEqual(await getNativeContextCompression.call(reopened), status);
  assert.deepEqual(await reopenedStore.getNativeContextForkBundle(PARENT), initialized);
  assert.deepEqual(await reopenedStore.messages({ sessionID: PARENT }), originalMessages);
  assert.deepEqual(reopened.messageHistory.borrowReadOnlyRuntimeEntries(), originalHistory);
  assert.deepEqual(await reopenedStore.queryTaskUsage({ sessionID: PARENT }), emptyUsage);
  assert.equal(modelCalls, 0);
  assert.equal(
    base.events.some(
      (event) =>
        event !== null &&
        typeof event === "object" &&
        "type" in event &&
        event.type === SessionEventType.ModelNetworkStatus,
    ),
    false,
  );
});

test("legacy compact without any main observation exposes the actual current owner segment", async (t) => {
  const { host, store } = await fixture(t, [compactMessage()]);
  await recoverNativeContext(host);
  const state = await store.getNativeContextState(PARENT);
  const status = nativeContextStatusSchema.parse(nativeStatus(nativeOwner(host)));
  assert.equal(status.currentSegmentId, "compact-boundary");
  assert.equal(status.currentSegmentId, state?.compactBoundaryId);
  assert.equal(status.lastObservation, null);
  assert.equal(status.lastOperation, null);
  assert.equal(status.policy.mode, "manual");
});

test("committed compact changes the current segment while retaining prior main facts and query fences", async (t) => {
  const { host, state, store } = await fixture(t);
  const main = observation("old-main", {
    anchorMessageId: "msg_first",
    segmentId: state.compactBoundaryId,
    historyVersion: state.historyVersion,
    status: "completed",
    actualInputTokens: 22,
    completedAt: 20,
  });
  await commit(host, state, { observations: [main], operations: [] });
  const owner = nativeOwner(host);
  owner.state = state;
  owner.lastObservation = main;
  const before = nativeContextStatusSchema.parse(nativeStatus(owner));
  const summary = compactMessage();
  await store.commitMessageBundle({ sessionID: PARENT, messages: [summary] });
  host.messageHistory.reset();
  host.messageHistory.addEntries([
    {
      message: { role: "user", content: "合成 compact 摘要" },
      canonical: {
        messageId: summary.info.id,
        partId: summary.parts[0]!.id,
        createdAt: 10,
        entryIndex: 0,
      },
    },
  ]);
  await resetNativeContextAfterCompact(host, "compact-boundary");
  const status = nativeContextStatusSchema.parse(nativeStatus(owner));
  assert.equal(status.currentSegmentId, "compact-boundary");
  assert.notEqual(status.currentSegmentId, before.currentSegmentId);
  assert.deepEqual(status.lastObservation, main);
  assert.notEqual(status.currentSegmentId, status.lastObservation?.segmentId);
  assert.notEqual(status.historyVersion, status.lastObservation?.historyVersion);
  assert.equal(status.lastOperation?.segmentId, status.currentSegmentId);
  assert.equal(status.lastOperation?.kind, "compact-boundary");
  const page = await store.listNativeContextObservations(PARENT, {
    purpose: "main",
    segmentId: status.currentSegmentId,
    expectedRevision: status.revision,
  });
  assert.deepEqual(page.items, []);
  assert.equal(page.revision, status.revision);
  assert.equal(page.generation, status.generation);
  assert.equal(page.historyVersion, status.historyVersion);
  await assert.rejects(
    store.listNativeContextObservations(PARENT, {
      expectedRevision: before.revision,
    }),
    NativeContextStoreConflictError,
  );
});
