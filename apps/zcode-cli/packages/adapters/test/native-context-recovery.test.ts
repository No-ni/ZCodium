import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createMessageId, createSessionId, type FilePart } from "@zcode/contracts";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import {
  assertProjectPath,
  createProjectTestFixture,
} from "../../../../../scripts/ci/project-test-sandbox.mjs";
import { createSqliteNativeContextRepository } from "../src/storage/session-store/native-context-compression/index.js";
import {
  createSession,
  listArtifactReferrers,
  softDeleteSession,
} from "../src/storage/session-store/repositories/sessions.js";
import {
  SESSION_ID,
  conflict,
  message,
  observation,
  operation,
  sessionInput,
  state,
} from "./fixtures/native-context-store.js";

test("cold reopen restores policy, kernel, operations and null/zero observations from an isolated database", async () => {
  const root = await createProjectTestFixture("native-context-cold");
  const dbPath = await assertProjectPath(join(root, "session.sqlite"));
  const initial = await createSqliteSessionStore({ dbPath });
  const frozen = observation("cold", {
    status: "error",
    actualInputTokens: 0,
    cacheReadTokens: null,
    completedAt: 20,
  });
  const stored = state({ kernel: { fixture: { blocks: ["synthetic"], refs: {} } } });
  try {
    await initial.createSession(sessionInput());
    await initial.commitNativeContext(SESSION_ID, {
      expectedRevision: null,
      expectedGeneration: 0,
      state: stored,
      observations: [frozen],
      operations: [operation()],
    });
  } finally {
    initial.close();
  }
  const reopened = await createSqliteSessionStore({ dbPath });
  try {
    assert.deepEqual(reopened.migrationResult.applied, []);
    assert.deepEqual(await reopened.getNativeContextState(SESSION_ID), stored);
    assert.deepEqual((await reopened.listNativeContextObservations(SESSION_ID, {})).items, [
      frozen,
    ]);
    assert.deepEqual(
      await reopened.getNativeContextOperation(SESSION_ID, "operation-0"),
      operation(),
    );
  } finally {
    reopened.close();
  }
});

test("cold recovery can explicitly read old membership after a persisted rewind interrupted rebuilding", async () => {
  const root = await createProjectTestFixture("native-context-stale");
  const dbPath = await assertProjectPath(join(root, "session.sqlite"));
  const initial = await createSqliteSessionStore({ dbPath });
  const retained = observation("retained");
  const discarded = observation("discarded");
  try {
    await initial.createSession(sessionInput());
    await initial.commitNativeContext(SESSION_ID, {
      expectedRevision: null,
      expectedGeneration: 0,
      state: state(),
      observations: [retained, discarded],
    });
    await initial.setRevert({
      sessionID: SESSION_ID,
      revert: { messageID: createMessageId("stale-anchor"), branchGeneration: 1 },
    });
  } finally {
    initial.close();
  }
  const reopened = await createSqliteSessionStore({ dbPath });
  try {
    await assert.rejects(reopened.getNativeContextForkBundle(SESSION_ID), conflict("generation"));
    const stale = (await reopened.getNativeContextForkBundle(SESSION_ID, {
      allowStaleGeneration: true,
    }))!;
    assert.deepEqual(stale.observations, [retained, discarded]);
    await reopened.commitNativeContext(SESSION_ID, {
      expectedRevision: stale.state.revision,
      expectedGeneration: 1,
      state: { ...stale.state, revision: 1, generation: 1 },
      observations: [retained],
    });
    assert.deepEqual((await reopened.listNativeContextObservations(SESSION_ID, {})).items, [
      retained,
    ]);
    assert.deepEqual((await reopened.getNativeContextForkBundle(SESSION_ID))!.observations, [
      retained,
    ]);
  } finally {
    reopened.close();
  }
});

test("canonical original image URI protects source artifacts even when historical JSON escaped slashes", async (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("pragma foreign_keys=on");
  db.exec(
    await readFile(
      new URL("../src/storage/session-store/schema.baseline.sql", import.meta.url),
      "utf8",
    ),
  );
  const parent = createSessionId("artifact-parent");
  const child = createSessionId("artifact-child");
  const kernelOnly = createSessionId("artifact-kernel-only");
  for (const id of [parent, child, kernelOnly]) createSession(db, sessionInput(id));
  const copied = message(child);
  const file: FilePart = {
    id: copied.parts[0]!.id,
    sessionID: child,
    messageID: copied.info.id,
    type: "file",
    mime: "image/png",
    url: "data:image/png;base64,AA==",
    metadata: { image: { originalArtifactUri: "zcode-artifact://" + parent + "/original-image" } },
  };
  // 按历史 JSON 字节播种，不能先用现行 writer 的编码器消除 slash 转义。
  db.prepare(
    "insert into message(id,session_id,sequence,time_created,time_updated,data) values(?,?,?,?,?,?)",
  ).run(copied.info.id, child, 0, 1, 1, JSON.stringify(copied.info));
  db.prepare(
    "insert into part(id,message_id,session_id,sequence,time_created,time_updated,data) values(?,?,?,?,?,?,?)",
  ).run(file.id, copied.info.id, child, 0, 1, 1, JSON.stringify(file).replaceAll("/", "\\/"));
  const repository = createSqliteNativeContextRepository(db);
  repository.commit(child, {
    expectedRevision: null,
    expectedGeneration: 0,
    state: state({
      kernel: { arbitraryUri: "zcode-artifact://" + kernelOnly + "/not-a-canonical-part" },
    }),
  });
  const refs = listArtifactReferrers(db, [parent, kernelOnly]);
  assert.deepEqual(refs.get(parent), [child]);
  assert.equal(refs.has(kernelOnly), false);
  softDeleteSession(db, child, 100);
  assert.equal(listArtifactReferrers(db, [parent]).size, 0);
  assert.deepEqual(db.prepare("pragma foreign_key_check").all(), []);
});
