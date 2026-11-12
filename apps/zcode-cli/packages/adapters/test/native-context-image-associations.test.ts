import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import type {
  NativeContextCommit,
  NativeContextImageReceipt,
} from "@zcode/shared/native-context-compression";
import {
  createSqliteNativeContextRepository,
  NATIVE_CONTEXT_COMPRESSION_MIGRATION,
} from "../src/storage/session-store/native-context-compression/index.js";
import {
  HASH,
  SESSION_ID,
  conflict,
  message,
  observation,
  operation,
  source,
  state,
} from "./fixtures/native-context-store.js";

function fixture(t: TestContext, omitted = false) {
  // 使用真实 SQLite 和正式三表 SQL；不启动Runtime、不引入测试专用存储实现。
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("pragma foreign_keys=on; create table session(id text primary key, revert text)");
  db.exec(NATIVE_CONTEXT_COMPRESSION_MIGRATION.sql);
  db.prepare("insert into session(id,revert) values(?,null)").run(SESSION_ID);
  const repository = createSqliteNativeContextRepository(db);
  const original = source(message(SESSION_ID), {
    kind: "image",
    sourceKind: "attachment",
    imageIndex: 0,
    artifactUri: "artifact:nctx-original",
    originalBytes: 128,
    width: 32,
    height: 16,
  });
  const own = observation("completed-image-main", {
    status: "completed",
    anchorMessageId: "image-assistant",
    requestSeq: 5,
    actualInputTokens: 4321,
    outputTokens: 12,
    cacheReadTokens: 0,
    completedAt: 20,
    operationIds: ["previous-op"],
    images: {
      ...observation().images,
      sourceCount: 1,
      sourceCoverage: 1,
      sentCount: omitted ? 0 : 1,
      omittedCount: omitted ? 1 : 0,
      beforeBytes: 128,
      afterBytes: omitted ? 0 : 32,
    },
  });
  const receipt: NativeContextImageReceipt = {
    ref: original.ref,
    responseMessageId: omitted ? "previous-assistant" : own.anchorMessageId!,
    logicalRequestId: omitted ? "previous-request" : own.logicalRequestId,
    modelKey: own.model.providerId + "/" + own.model.modelId,
    policyHash: HASH,
    representationHash: "2".repeat(64),
    generation: own.generation,
  };
  const view = {
    artifactUri: "artifact:nctx-view",
    mediaType: "image/png",
    bytes: 32,
    policyHash: receipt.policyHash,
    representationHash: receipt.representationHash,
  };
  const base = state({
    requestSeq: own.requestSeq,
    sources: [original],
    kernel: omitted ? { imageViews: { [original.ref]: view } } : {},
    imageReceipts: omitted ? [receipt] : [],
  });
  const previous = operation("previous-op", {
    status: "completed",
    completedAt: 20,
    observationIds: [own.id],
    beforeEstimate: own.beforeEstimate,
    afterEstimate: own.afterEstimate,
  });
  repository.commit(SESSION_ID, {
    expectedRevision: null,
    expectedGeneration: 0,
    state: base,
    operations: [previous],
    observations: [own, observation("other-point")],
  });
  const image = operation("new-image-op", {
    kind: "image",
    status: "completed",
    anchorMessageId: own.anchorMessageId,
    anchorRequestSeq: own.requestSeq,
    model: own.model,
    completedAt: 30,
    reason: "none",
    elapsedMs: 0,
    beforeEstimate: own.beforeEstimate,
    afterEstimate: own.afterEstimate,
    observationIds: [own.id],
    sources: [
      {
        ref: original.ref,
        messageId: original.messageId,
        partId: original.partId,
        imageIndex: original.imageIndex,
        kind: "image",
        originalAvailable: original.originalAvailable,
      },
    ],
  });
  const candidate: NativeContextCommit = {
    expectedRevision: 0,
    expectedGeneration: 0,
    state: {
      ...base,
      revision: 1,
      imageReceipts: [receipt],
      kernel: {
        imageViews: { [original.ref]: view },
        omittedImageRefs: omitted ? [original.ref] : [],
      },
    },
    operations: [image],
    observations: [{ ...own, operationIds: [...own.operationIds, image.operationId] }],
  };
  return { db, repository, base, own, original, image, candidate };
}

function snapshot(db: DatabaseSync) {
  return ["native_context_state", "native_context_operation", "native_context_observation"].map(
    (table) => db.prepare(`select * from ${table} order by rowid`).all(),
  );
}

test("completed main image association atomically appends, preserves all facts and sequence, and exact retry is idempotent", (t) => {
  const value = fixture(t);
  const sequence = value.db
    .prepare("select sequence from native_context_observation where id=?")
    .get(value.own.id);
  value.repository.commit(SESSION_ID, value.candidate);
  const committed = snapshot(value.db);
  value.repository.commit(SESSION_ID, structuredClone(value.candidate));
  assert.deepEqual(snapshot(value.db), committed);
  assert.deepEqual(
    value.db
      .prepare("select sequence from native_context_observation where id=?")
      .get(value.own.id),
    sequence,
  );
  const linked = value.repository.listObservations(SESSION_ID, {
    operationId: value.image.operationId,
  }).items;
  assert.deepEqual(linked, value.candidate.observations);
  const { operationIds: _old, ...before } = value.own;
  const { operationIds: _new, ...after } = linked[0]!;
  assert.deepEqual(after, before);
  assert.deepEqual(
    value.repository.getOperation(SESSION_ID, value.image.operationId)?.observationIds,
    [value.own.id],
  );
  assert.equal(value.repository.listObservations(SESSION_ID, {}).items.length, 2);
  assert.equal(value.repository.listOperations(SESSION_ID, {}).items.length, 2);
  assert.deepEqual(value.db.prepare("pragma foreign_key_check").all(), []);
});

test("omitted image association requires the retained prior receipt and same image representation", (t) => {
  const value = fixture(t, true);
  value.repository.commit(SESSION_ID, value.candidate);
  assert.deepEqual(value.repository.getState(SESSION_ID), value.candidate.state);
  assert.deepEqual(
    value.repository.listObservations(SESSION_ID, { operationId: value.image.operationId }).items,
    value.candidate.observations,
  );
});

type Mutation = (candidate: NativeContextCommit) => void;
type ImageOperation = NonNullable<NativeContextCommit["operations"]>[number];
type MainObservation = NonNullable<NativeContextCommit["observations"]>[number];
type RecordedSource = ImageOperation["sources"][number];
const changeOperation =
  (changes: Partial<ImageOperation>): Mutation =>
  (value) => {
    Object.assign(value.operations![0]!, changes);
  };
const changeObservation =
  (changes: Partial<MainObservation>): Mutation =>
  (value) => {
    Object.assign(value.observations![0]!, changes);
  };
const changeSource =
  (changes: Partial<RecordedSource>): Mutation =>
  (value) => {
    Object.assign(value.operations![0]!.sources[0]!, changes);
  };
const changeReceipt =
  (changes: Partial<NativeContextImageReceipt>): Mutation =>
  (value) => {
    Object.assign(value.state.imageReceipts[0]!, changes);
  };
const changeCommit =
  (changes: Partial<NativeContextCommit>): Mutation =>
  (value) => {
    Object.assign(value, changes);
  };
const changeState =
  (changes: Partial<NativeContextCommit["state"]>): Mutation =>
  (value) => {
    Object.assign(value.state, changes);
  };
const badUpdates: Array<[string, Mutation]> = [
  ["missing operation", changeCommit({ operations: [] })],
  ["missing reverse observation update", changeCommit({ observations: [] })],
  ["wrong operation kind", changeOperation({ kind: "restore-image" })],
  ["wrong operation model", changeOperation({ model: { providerId: "other", modelId: "other" } })],
  ["wrong assistant anchor", changeOperation({ anchorMessageId: "another-assistant" })],
  ["wrong request sequence", changeOperation({ anchorRequestSeq: 6 })],
  ["wrong generation", changeOperation({ generation: 1 })],
  ["wrong history", changeOperation({ historyVersion: "different-history" })],
  ["wrong policy", changeOperation({ policyVersion: 2 })],
  ["wrong segment", changeOperation({ segmentId: "different-segment" })],
  ["inherited operation", changeOperation({ origin: "inherited" })],
  ["cancelled operation", changeOperation({ status: "cancelled" })],
  ["failed operation", changeOperation({ status: "error" })],
  ["wrong reverse observation", changeOperation({ observationIds: ["other-point"] })],
  [
    "multiple reverse observations",
    changeOperation({ observationIds: ["completed-image-main", "other-point"] }),
  ],
  ["deleted existing prefix", changeObservation({ operationIds: ["new-image-op"] })],
  [
    "reordered existing prefix",
    changeObservation({ operationIds: ["new-image-op", "previous-op"] }),
  ],
  [
    "duplicate association",
    changeObservation({ operationIds: ["previous-op", "new-image-op", "new-image-op"] }),
  ],
  ["changed input cost", changeObservation({ actualInputTokens: 999 })],
  ["changed output cost", changeObservation({ outputTokens: 999 })],
  ["changed cache cost", changeObservation({ cacheReadTokens: null })],
  ["changed estimate", changeObservation({ afterEstimate: 999 })],
  [
    "changed image facts",
    (v) => {
      v.observations![0]!.images.afterBytes = 999;
    },
  ],
  ["changed completed time", changeObservation({ completedAt: 999 })],
  ["missing source", changeOperation({ sources: [] })],
  ["unknown source ref", changeSource({ ref: "foreign-ref" })],
  ["wrong source message", changeSource({ messageId: "foreign-message" })],
  ["wrong source part", changeSource({ partId: "foreign-part" })],
  ["wrong source image index", changeSource({ imageIndex: 1 })],
  ["wrong source kind", changeSource({ kind: "text" })],
  ["forged original availability", changeSource({ originalAvailable: false })],
  [
    "changed state source",
    (v) => {
      v.state.sources[0]!.contentHash = "3".repeat(64);
    },
  ],
  ["missing receipt", changeState({ imageReceipts: [] })],
  ["wrong receipt request", changeReceipt({ logicalRequestId: "foreign-request" })],
  ["wrong receipt response", changeReceipt({ responseMessageId: "foreign-response" })],
  ["wrong receipt generation", changeReceipt({ generation: 1 })],
  ["wrong receipt model", changeReceipt({ modelKey: "foreign/model" })],
  ["wrong representation", changeReceipt({ representationHash: "4".repeat(64) })],
  ["missing image view", changeState({ kernel: { imageViews: {} } })],
];
for (const [label, mutate] of badUpdates)
  test(`image association rejects ${label} and rolls the entire CAS back`, (t) => {
    const value = fixture(t);
    const before = snapshot(value.db);
    const candidate = structuredClone(value.candidate);
    mutate(candidate);
    assert.throws(() => value.repository.commit(SESSION_ID, candidate), conflict("record"));
    assert.deepEqual(snapshot(value.db), before);
  });

for (const purpose of ["maintenance", "decision"] as const)
  test(`image association cannot decorate a completed ${purpose} observation`, (t) => {
    const value = fixture(t);
    const old = { ...value.own, purpose };
    value.db
      .prepare("update native_context_observation set purpose=?, data=? where id=?")
      .run(purpose, JSON.stringify(old), old.id);
    value.candidate.observations![0]!.purpose = purpose;
    const before = snapshot(value.db);
    assert.throws(() => value.repository.commit(SESSION_ID, value.candidate), conflict("record"));
    assert.deepEqual(snapshot(value.db), before);
  });

for (const status of ["prepared", "cancelled", "error", "obsolete"] as const)
  test(`image association cannot decorate a ${status} main observation`, (t) => {
    const value = fixture(t);
    const old = { ...value.own, status };
    value.db
      .prepare("update native_context_observation set data=? where id=?")
      .run(JSON.stringify(old), old.id);
    value.candidate.observations![0]!.status = status;
    const before = snapshot(value.db);
    assert.throws(() => value.repository.commit(SESSION_ID, value.candidate), conflict("record"));
    assert.deepEqual(snapshot(value.db), before);
  });

test("inherited completed main cannot be rewritten with an own image association", (t) => {
  const value = fixture(t);
  const old = { ...value.own, origin: "inherited" };
  value.db
    .prepare("update native_context_observation set data=? where id=?")
    .run(JSON.stringify(old), old.id);
  value.candidate.observations![0]!.origin = "inherited";
  const before = snapshot(value.db);
  assert.throws(() => value.repository.commit(SESSION_ID, value.candidate), conflict("record"));
  assert.deepEqual(snapshot(value.db), before);
});

test("an image operation that already exists cannot be appended under a new CAS", (t) => {
  const value = fixture(t);
  value.db
    .prepare("insert into native_context_operation values(?,?,?,?,?,?)")
    .run(
      SESSION_ID,
      value.image.operationId,
      2,
      0,
      value.image.segmentId,
      JSON.stringify(value.image),
    );
  const before = snapshot(value.db);
  assert.throws(() => value.repository.commit(SESSION_ID, value.candidate), conflict("record"));
  assert.deepEqual(snapshot(value.db), before);
});

test("SQLite observation write fault rolls receipts, view and image record back without hiding the failure", (t) => {
  const value = fixture(t);
  value.db.exec(
    "create trigger image_write_fault before update on native_context_observation begin select raise(abort,'synthetic_image_write_fault'); end",
  );
  const before = snapshot(value.db);
  assert.throws(
    () => value.repository.commit(SESSION_ID, value.candidate),
    /synthetic_image_write_fault/u,
  );
  assert.deepEqual(snapshot(value.db), before);
});

test("cancelled image operation is saved without associating or persisting a sent receipt", (t) => {
  const value = fixture(t);
  const cancelled = {
    ...value.image,
    status: "cancelled" as const,
    reason: "cancelled" as const,
    observationIds: [],
  };
  value.repository.commit(SESSION_ID, {
    ...value.candidate,
    state: { ...value.base, revision: 1 },
    operations: [cancelled],
    observations: [],
  });
  assert.deepEqual(value.repository.getOperation(SESSION_ID, value.image.operationId), cancelled);
  assert.deepEqual(value.repository.getState(SESSION_ID)?.imageReceipts, []);
  assert.deepEqual(
    value.repository.listObservations(SESSION_ID, { operationId: value.image.operationId }).items,
    [],
  );
  assert.deepEqual(
    value.repository
      .listObservations(SESSION_ID, {})
      .items.find((item) => item.id === value.own.id),
    value.own,
  );
});

test("missing observed usage may save an unlinked image operation without inventing a point", (t) => {
  const value = fixture(t);
  value.repository.commit(SESSION_ID, {
    ...value.candidate,
    operations: [{ ...value.image, observationIds: [] }],
    observations: [],
  });
  assert.deepEqual(
    value.repository.getOperation(SESSION_ID, value.image.operationId)?.observationIds,
    [],
  );
  assert.equal(value.repository.listObservations(SESSION_ID, {}).items.length, 2);
  assert.deepEqual(
    value.repository.listObservations(SESSION_ID, { operationId: value.image.operationId }).items,
    [],
  );
});
