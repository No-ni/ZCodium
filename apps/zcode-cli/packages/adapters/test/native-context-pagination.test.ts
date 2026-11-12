import assert from "node:assert/strict";
import test from "node:test";
import { createMessageId } from "@zcode/contracts";
import {
  SESSION_ID,
  conflict,
  memoryStore,
  observation,
  operation,
  sessionInput,
  state,
} from "./fixtures/native-context-store.js";

test("purpose, operation association and segment filters apply before SQL pagination", async (t) => {
  const store = await memoryStore(t);
  await store.createSession(sessionInput());
  await store.commitNativeContext(SESSION_ID, {
    expectedRevision: null,
    expectedGeneration: 0,
    state: state(),
    operations: [operation("op-1"), operation("op-10")],
  });
  const points = [
    observation("main-old"),
    observation("maintenance-op-1", { purpose: "maintenance", operationIds: ["op-1"] }),
    observation("maintenance-op-10", { purpose: "maintenance", operationIds: ["op-10"] }),
    observation("main-new", { segmentId: "segment-1" }),
    ...Array.from({ length: 260 }, (_, index) =>
      observation("maintenance-" + index, {
        purpose: "maintenance",
        segmentId: "segment-1",
      }),
    ),
  ];
  let revision = 0;
  for (let offset = 0; offset < points.length; offset += 100) {
    await store.commitNativeContext(SESSION_ID, {
      expectedRevision: revision,
      expectedGeneration: 0,
      state: state({ revision: revision + 1 }),
      observations: points.slice(offset, offset + 100),
    });
    revision++;
  }
  const first = await store.listNativeContextObservations(SESSION_ID, {
    purpose: "main",
    limit: 1,
    expectedRevision: revision,
  });
  assert.deepEqual(
    first.items.map((point) => point.id),
    ["main-new"],
  );
  assert.notEqual(first.nextCursor, null);
  const second = await store.listNativeContextObservations(SESSION_ID, {
    purpose: "main",
    limit: 1,
    cursor: first.nextCursor!,
    expectedRevision: revision,
  });
  assert.deepEqual(
    second.items.map((point) => point.id),
    ["main-old"],
  );
  assert.equal(second.nextCursor, null);
  assert.deepEqual(
    (
      await store.listNativeContextObservations(SESSION_ID, {
        purpose: "main",
        segmentId: "segment-0",
        limit: 1,
      })
    ).items.map((point) => point.id),
    ["main-old"],
  );
  assert.deepEqual(
    (
      await store.listNativeContextObservations(SESSION_ID, {
        operationId: "op-1",
        purpose: "maintenance",
        limit: 1,
      })
    ).items.map((point) => point.id),
    ["maintenance-op-1"],
  );
  assert.deepEqual(
    (
      await store.listNativeContextObservations(SESSION_ID, {
        operationId: "op-1",
        purpose: "main",
      })
    ).items,
    [],
  );
  assert.equal((await store.listNativeContextObservations(SESSION_ID, {})).items.length, 50);
  const large = await store.listNativeContextObservations(SESSION_ID, { limit: 200 });
  assert.equal(large.items.length, 200);
  assert.notEqual(large.nextCursor, null);
  assert.equal(
    (
      await store.listNativeContextOperations(SESSION_ID, {
        purpose: "decision",
        operationId: "absent",
        limit: 1,
      })
    ).items[0]!.operationId,
    "op-10",
  );
  await assert.rejects(store.listNativeContextObservations(SESSION_ID, { limit: 201 }));
  await store.commitNativeContext(SESSION_ID, {
    expectedRevision: revision,
    expectedGeneration: 0,
    state: state({ revision: revision + 1 }),
  });
  await assert.rejects(
    store.listNativeContextObservations(SESSION_ID, {
      purpose: "main",
      cursor: first.nextCursor!,
      expectedRevision: revision,
    }),
    conflict("revision"),
  );
});

test("rewind moves retained membership without rewriting request facts or revealing future records", async (t) => {
  const store = await memoryStore(t);
  await store.createSession(sessionInput());
  const retained = observation("retained", {
    status: "completed",
    actualInputTokens: 17,
    completedAt: 20,
  });
  const keptOperation = operation("retained-operation", {
    status: "completed",
    reason: "none",
    completedAt: 20,
    summary: "合成已保存摘要",
  });
  await store.commitNativeContext(SESSION_ID, {
    expectedRevision: null,
    expectedGeneration: 0,
    state: state(),
    observations: [retained, observation("future")],
    operations: [keptOperation, operation("future-operation")],
  });
  await store.setRevert({
    sessionID: SESSION_ID,
    revert: { messageID: createMessageId("rewind-anchor"), branchGeneration: 1 },
  });
  assert.deepEqual(await store.getNativeContextState(SESSION_ID), state());
  await assert.rejects(store.listNativeContextObservations(SESSION_ID, {}), conflict("generation"));
  await assert.rejects(
    store.getNativeContextOperation(SESSION_ID, "future-operation"),
    conflict("generation"),
  );
  await assert.rejects(store.getNativeContextForkBundle(SESSION_ID), conflict("generation"));
  assert.deepEqual(
    (await store.getNativeContextForkBundle(SESSION_ID, {
      allowStaleGeneration: true,
    }))!.observations,
    [retained, observation("future")],
  );
  await assert.rejects(
    store.commitNativeContext(SESSION_ID, {
      expectedRevision: 0,
      expectedGeneration: 0,
      state: state({ revision: 1 }),
    }),
    conflict("generation"),
  );
  const rebuilt = state({ revision: 1, generation: 1, historyVersion: "history-1" });
  await store.commitNativeContext(SESSION_ID, {
    expectedRevision: 0,
    expectedGeneration: 1,
    state: rebuilt,
    observations: [retained],
    operations: [keptOperation],
  });
  const page = await store.listNativeContextObservations(SESSION_ID, {});
  assert.deepEqual(page.items, [retained]);
  assert.equal(page.generation, 1);
  assert.equal(page.historyVersion, "history-1");
  assert.equal(page.items[0]!.generation, 0);
  assert.equal(page.items[0]!.historyVersion, "history-0");
  assert.equal(await store.getNativeContextOperation(SESSION_ID, "future-operation"), null);
  assert.deepEqual((await store.getNativeContextForkBundle(SESSION_ID))!.operations, [
    keptOperation,
  ]);
  const current = observation("current", {
    generation: 1,
    historyVersion: "history-1",
    model: { providerId: "fixture-provider", modelId: "changed-model" },
    segmentId: "segment-1",
  });
  await store.commitNativeContext(SESSION_ID, {
    expectedRevision: 1,
    expectedGeneration: 1,
    state: { ...rebuilt, revision: 2 },
    observations: [current],
  });
  assert.deepEqual((await store.listNativeContextObservations(SESSION_ID, {})).items, [
    current,
    retained,
  ]);
  // 深度 compact 只换分段，数据库 branch generation 和冻结旧点都不伪增。
  await store.commitNativeContext(SESSION_ID, {
    expectedRevision: 2,
    expectedGeneration: 1,
    state: { ...rebuilt, revision: 3, compactBoundaryId: "compact-1" },
  });
  assert.deepEqual(
    (
      await store.listNativeContextObservations(SESSION_ID, {
        segmentId: "segment-0",
      })
    ).items,
    [retained],
  );
});
