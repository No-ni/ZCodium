import assert from "node:assert/strict";
import test from "node:test";
import { createSessionId } from "@zcode/contracts";
import {
  SESSION_ID,
  conflict,
  memoryStore,
  observation,
  operation,
  sessionInput,
  state,
} from "./fixtures/native-context-store.js";

test("native context is optional until initialized and read-only queries do not write a policy", async (t) => {
  const store = await memoryStore(t);
  await store.createSession(sessionInput());
  assert.equal(await store.getNativeContextState(SESSION_ID), null);
  assert.equal(await store.getNativeContextForkBundle(SESSION_ID), null);
  assert.deepEqual(await store.listNativeContextObservations(SESSION_ID, {}), {
    items: [],
    nextCursor: null,
    revision: 0,
    generation: 0,
    historyVersion: "uninitialized",
  });
  assert.equal(await store.getNativeContextState(SESSION_ID), null);
  await assert.rejects(
    store.commitNativeContext(createSessionId("missing"), {
      expectedRevision: null,
      expectedGeneration: 0,
      state: state(),
    }),
    conflict("missing-session"),
  );
});

test("initialization, CAS and exact retry preserve state and observation identities", async (t) => {
  const store = await memoryStore(t);
  await store.createSession(sessionInput());
  const first = {
    expectedRevision: null,
    expectedGeneration: 0,
    state: state(),
    observations: [observation()],
    operations: [operation()],
  };
  await store.commitNativeContext(SESSION_ID, first);
  await store.commitNativeContext(SESSION_ID, structuredClone(first));
  assert.equal((await store.listNativeContextObservations(SESSION_ID, {})).items.length, 1);
  assert.equal((await store.listNativeContextOperations(SESSION_ID, {})).items.length, 1);
  await assert.rejects(
    store.commitNativeContext(SESSION_ID, {
      ...first,
      state: state({ kernel: { different: true } }),
    }),
    conflict("revision"),
  );
  await assert.rejects(
    store.commitNativeContext(SESSION_ID, {
      ...first,
      observations: [observation("different")],
    }),
    conflict("revision"),
  );
  await assert.rejects(
    store.commitNativeContext(SESSION_ID, {
      expectedRevision: 0,
      expectedGeneration: 0,
      state: state({ revision: 2 }),
    }),
    conflict("revision"),
  );
  await store.commitNativeContext(SESSION_ID, {
    expectedRevision: 0,
    expectedGeneration: 0,
    state: state({ revision: 1, requestSeq: 1 }),
  });
  await assert.rejects(store.commitNativeContext(SESSION_ID, first), conflict("revision"));
  assert.equal((await store.getNativeContextState(SESSION_ID))!.revision, 1);
});

test("unknown usage stays null, true zero stays zero and completion never rewrites a frozen request", async (t) => {
  const store = await memoryStore(t);
  await store.createSession(sessionInput());
  const prepared = observation("frozen", {
    images: {
      ...observation().images,
      sourceCount: 1,
      sourceCoverage: 0,
      beforeBytes: null,
      afterBytes: null,
    },
  });
  await store.commitNativeContext(SESSION_ID, {
    expectedRevision: null,
    expectedGeneration: 0,
    state: state(),
    observations: [prepared],
  });
  assert.deepEqual((await store.listNativeContextObservations(SESSION_ID, {})).items, [prepared]);
  const completed = {
    ...prepared,
    status: "completed" as const,
    actualInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: null,
    visionTokens: null,
    completedAt: 20,
  };
  const terminalCommit = {
    expectedRevision: 0,
    expectedGeneration: 0,
    state: state({ revision: 1 }),
    observations: [completed],
  };
  await store.commitNativeContext(SESSION_ID, terminalCommit);
  await store.commitNativeContext(SESSION_ID, terminalCommit);
  assert.deepEqual((await store.listNativeContextObservations(SESSION_ID, {})).items, [completed]);
  for (const mutation of [
    prepared,
    { ...completed, actualInputTokens: 1 },
    { ...completed, afterEstimate: 1 },
    { ...completed, model: { providerId: "other", modelId: "other" } },
  ]) {
    await assert.rejects(
      store.commitNativeContext(SESSION_ID, {
        expectedRevision: 1,
        expectedGeneration: 0,
        state: state({ revision: 2 }),
        observations: [mutation],
      }),
      conflict("record"),
    );
  }
  assert.equal((await store.getNativeContextState(SESSION_ID))!.revision, 1);
});

test("duplicate attempt conflicts roll back state, operations and earlier observations together", async (t) => {
  const store = await memoryStore(t);
  await store.createSession(sessionInput());
  const original = observation("original");
  await store.commitNativeContext(SESSION_ID, {
    expectedRevision: null,
    expectedGeneration: 0,
    state: state(),
    observations: [original],
  });
  await assert.rejects(
    store.commitNativeContext(SESSION_ID, {
      expectedRevision: 0,
      expectedGeneration: 0,
      state: state({ revision: 1, kernel: { candidate: true } }),
      operations: [operation("rollback")],
      observations: [
        observation("inserted-before-failure"),
        { ...original, id: "attempt-collision" },
      ],
    }),
    conflict("record"),
  );
  assert.deepEqual(await store.getNativeContextState(SESSION_ID), state());
  assert.equal(await store.getNativeContextOperation(SESSION_ID, "rollback"), null);
  assert.deepEqual((await store.listNativeContextObservations(SESSION_ID, {})).items, [original]);
});

test("operation anchors remain frozen while a preparing operation is settled", async (t) => {
  const store = await memoryStore(t);
  await store.createSession(sessionInput());
  const pending = operation("pending-anchor", {
    anchorMessageId: "original-message",
    anchorRequestSeq: 2,
    status: "preparing",
  });
  await store.commitNativeContext(SESSION_ID, {
    expectedRevision: null,
    expectedGeneration: 0,
    state: state(),
    operations: [pending],
  });
  for (const changed of [{ anchorMessageId: "other-message" }, { anchorRequestSeq: 3 }]) {
    await assert.rejects(
      store.commitNativeContext(SESSION_ID, {
        expectedRevision: 0,
        expectedGeneration: 0,
        state: state({ revision: 1 }),
        operations: [
          {
            ...pending,
            ...changed,
            status: "error",
            reason: "model-error",
            completedAt: 20,
            elapsedMs: 10,
          },
        ],
      }),
      conflict("record"),
    );
  }
  assert.deepEqual(await store.getNativeContextOperation(SESSION_ID, pending.operationId), pending);
  assert.equal((await store.getNativeContextState(SESSION_ID))?.revision, 0);
});

test("a queued operation freezes its execution boundary once and moves to the actual segment index", async (t) => {
  const store = await memoryStore(t);
  await store.createSession(sessionInput());
  const pending = operation("queued", {
    commandId: "manual",
    trigger: "manual",
    anchorMessageId: null,
    anchorRequestSeq: 1,
  });
  await store.commitNativeContext(SESSION_ID, {
    expectedRevision: null,
    expectedGeneration: 0,
    state: state(),
    operations: [pending],
  });
  const running = {
    ...pending,
    status: "running" as const,
    historyVersion: "new-history",
    policyVersion: 4,
    segmentId: "new-segment",
    anchorMessageId: "current-message",
    anchorRequestSeq: 7,
  };
  await store.commitNativeContext(SESSION_ID, {
    expectedRevision: 0,
    expectedGeneration: 0,
    state: state({ revision: 1, compactBoundaryId: "new-segment" }),
    operations: [running],
  });
  const { sources, summary, ...runningSummary } = running;
  void sources;
  void summary;
  assert.deepEqual(
    (await store.listNativeContextOperations(SESSION_ID, { segmentId: "new-segment" })).items,
    [runningSummary],
  );
  assert.deepEqual(
    (await store.listNativeContextOperations(SESSION_ID, { segmentId: "segment-0" })).items,
    [],
  );
  for (const changed of [
    { anchorMessageId: "later-message" },
    { anchorRequestSeq: 8 },
    { historyVersion: "later-history" },
    { policyVersion: 5 },
    { segmentId: "later-segment" },
    { createdAt: 11 },
    { commandId: "other" },
  ]) {
    await assert.rejects(
      store.commitNativeContext(SESSION_ID, {
        expectedRevision: 1,
        expectedGeneration: 0,
        state: state({ revision: 2, compactBoundaryId: "new-segment" }),
        operations: [{ ...running, ...changed }],
      }),
      conflict("record"),
    );
  }
  assert.deepEqual(await store.getNativeContextOperation(SESSION_ID, pending.operationId), running);
});

test("maintenance errors retain their real usage and never create a main request point", async (t) => {
  const store = await memoryStore(t);
  await store.createSession(sessionInput());
  const maintenance = observation("maintenance", {
    purpose: "maintenance",
    operationIds: ["failed-operation"],
    status: "error",
    beforeEstimate: null,
    afterEstimate: null,
    actualInputTokens: 31,
    outputTokens: 2,
    completedAt: 20,
  });
  const failed = operation("failed-operation", {
    status: "error",
    reason: "model-error",
    completedAt: 20,
    elapsedMs: 10,
    observationIds: [maintenance.id],
  });
  await store.commitNativeContext(SESSION_ID, {
    expectedRevision: null,
    expectedGeneration: 0,
    state: state(),
    observations: [maintenance],
    operations: [failed],
  });
  assert.deepEqual(
    (await store.listNativeContextObservations(SESSION_ID, { purpose: "main" })).items,
    [],
  );
  assert.deepEqual(
    (await store.listNativeContextObservations(SESSION_ID, { operationId: failed.operationId }))
      .items,
    [maintenance],
  );
  assert.deepEqual(await store.getNativeContextOperation(SESSION_ID, failed.operationId), failed);
  const summaries = await store.listNativeContextOperations(SESSION_ID, { purpose: "main" });
  assert.equal(summaries.items.length, 1);
  assert.equal("sources" in summaries.items[0]!, false);
  assert.equal("summary" in summaries.items[0]!, false);
  await assert.rejects(
    store.commitNativeContext(SESSION_ID, {
      expectedRevision: 0,
      expectedGeneration: 0,
      state: state({ revision: 1 }),
      operations: [{ ...failed, status: "preparing" }],
    }),
    conflict("record"),
  );
});

test("tasks isolate identical logical IDs; soft deletion preserves facts and purge cascades", async (t) => {
  const store = await memoryStore(t);
  const other = createSessionId("native-context-other");
  for (const id of [SESSION_ID, other]) {
    await store.createSession(sessionInput(id));
    await store.commitNativeContext(id, {
      expectedRevision: null,
      expectedGeneration: 0,
      state: state(),
      observations: [observation()],
      operations: [operation()],
    });
  }
  await store.softDeleteSession(SESSION_ID, 100);
  assert.deepEqual(await store.getNativeContextState(SESSION_ID), state());
  await store.purgeSessions([SESSION_ID]);
  assert.equal(await store.getNativeContextState(SESSION_ID), null);
  assert.equal(await store.getNativeContextOperation(SESSION_ID, "operation-0"), null);
  assert.equal((await store.getNativeContextForkBundle(other))!.observations.length, 1);
});
