import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import {
  assertProjectPath,
  createProjectTestFixture,
} from "../../../../../scripts/ci/project-test-sandbox.mjs";
import {
  accountSessionTargetUsage,
  readSessionTarget,
  setSessionTarget,
} from "../src/storage/session-target.js";
import { createSession } from "../src/storage/session-store/repositories/sessions.js";
import {
  CHILD_ID,
  memoryStore,
  SESSION_ID,
  sessionInput,
} from "./fixtures/native-context-store.js";

const baseline = new URL("../src/storage/session-store/schema.baseline.sql", import.meta.url);
const PHYSICAL = "usage_model_native_context_maintenance_receipt-physical_0";

async function receiptDatabase(t: TestContext) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("pragma foreign_keys=on");
  db.exec(await readFile(baseline, "utf8"));
  createSession(db, sessionInput());
  const goal = setSessionTarget(db, {
    sessionID: SESSION_ID,
    objective: "Synthetic receipt Goal.",
    status: "active",
    tokenBudget: 100,
  });
  const receiptCount = () =>
    Number(db.prepare("select count(*) as n from session_target_usage_receipt").get()!.n);
  const account = (usageID = PHYSICAL, tokensUsedDelta = 12) =>
    accountSessionTargetUsage(db, {
      sessionID: SESSION_ID,
      targetID: goal.targetID,
      usageID,
      tokensUsedDelta,
    });
  return { db, goal, receiptCount, account };
}

test("the public Goal owner deduplicates a physical receipt while legacy deltas and the active run keep their contracts", async (t) => {
  const store = await memoryStore(t);
  await store.createSession(sessionInput());
  const goal = await store.setTarget({
    sessionID: SESSION_ID,
    objective: "Synthetic Goal.",
    tokenBudget: 40,
  });
  await store.startTargetRun({
    sessionID: SESSION_ID,
    targetID: goal.targetID,
    inputID: "main-input",
    startedAtMs: 100,
  });
  const account = () =>
    store.accountTargetUsage({
      sessionID: SESSION_ID,
      targetID: goal.targetID,
      usageID: PHYSICAL,
      tokensUsedDelta: 30,
    });
  const first = await account();
  const duplicate = await account();
  assert.equal(first?.tokensUsed, 30);
  assert.equal(duplicate?.tokensUsed, 30);
  assert.equal(duplicate?.activeInputId, "main-input");
  assert.equal(duplicate?.activeRunStartedAtMs, 100);
  await store.accountTargetUsage({
    sessionID: SESSION_ID,
    targetID: goal.targetID,
    tokensUsedDelta: 5,
  });
  const legacy = await store.accountTargetUsage({
    sessionID: SESSION_ID,
    targetID: goal.targetID,
    tokensUsedDelta: 5,
  });
  assert.equal(legacy?.tokensUsed, 40);
  assert.equal(legacy?.status, "budget_limited");
  assert.equal(legacy?.activeInputId, "main-input");
});

test("failed retry, successful retry and HTTP fallback receipts use separate stable physical keys", async (t) => {
  const f = await receiptDatabase(t);
  f.account("usage_model_native_context_maintenance_stream_0", 12);
  f.account("usage_model_native_context_maintenance_stream_1", 20);
  f.account("usage_model_native_context_maintenance_http_0", 8);
  f.account("usage_model_native_context_maintenance_stream_0", 12);
  assert.equal(readSessionTarget(f.db, { sessionID: SESSION_ID })?.tokensUsed, 40);
  assert.equal(f.receiptCount(), 3);
});

test("a real zero retains its receipt and a repeated physical ID cannot overwrite its settled amount", async (t) => {
  const f = await receiptDatabase(t);
  assert.equal(f.account(PHYSICAL, 0)?.tokensUsed, 0);
  assert.equal(f.receiptCount(), 1);
  assert.equal(f.account(PHYSICAL, 12)?.tokensUsed, 0);
  assert.equal(f.receiptCount(), 1);
  assert.equal(readSessionTarget(f.db, { sessionID: SESSION_ID })?.status, "active");
});

for (const [name, sql] of [
  [
    "receipt insert",
    "create trigger fail_goal_receipt before insert on session_target_usage_receipt begin select raise(abort, 'synthetic receipt write fault'); end",
  ],
  [
    "Goal count",
    "create trigger fail_goal_receipt before update of tokens_used on session_target begin select raise(abort, 'synthetic Goal write fault'); end",
  ],
  [
    "session touch",
    "create trigger fail_goal_receipt before update of time_updated on session begin select raise(abort, 'synthetic session write fault'); end",
  ],
] as const) {
  test(name + " failure rolls back its receipt and exact retry settles once", async (t) => {
    const f = await receiptDatabase(t);
    f.db.exec(sql);
    assert.throws(() => f.account(), /synthetic/);
    assert.equal(f.receiptCount(), 0);
    assert.equal(readSessionTarget(f.db, { sessionID: SESSION_ID })?.tokensUsed, 0);
    assert.equal(f.db.isTransaction, false);
    f.db.exec("drop trigger fail_goal_receipt");
    assert.equal(f.account()?.tokensUsed, 12);
    assert.equal(f.account()?.tokensUsed, 12);
    assert.equal(f.receiptCount(), 1);
  });
}

test("clearing or replacing a Goal cannot charge a frozen old owner or leave an unearned receipt", async (t) => {
  const f = await receiptDatabase(t);
  f.account("paid-before-clear", 10);
  f.db.prepare("delete from session_target where session_id=?").run(SESSION_ID);
  assert.equal(f.account("late-after-clear"), null);
  assert.equal(f.receiptCount(), 1);
  const replacement = setSessionTarget(f.db, {
    sessionID: SESSION_ID,
    objective: "Replacement synthetic Goal.",
    status: "active",
    tokenBudget: 100,
  });
  assert.equal(f.account("late-after-replace")?.targetID, replacement.targetID);
  assert.equal(readSessionTarget(f.db, { sessionID: SESSION_ID })?.tokensUsed, 0);
  assert.equal(f.receiptCount(), 1);
  const own = accountSessionTargetUsage(f.db, {
    sessionID: SESSION_ID,
    targetID: replacement.targetID,
    usageID: "paid-before-clear",
    tokensUsedDelta: 7,
  });
  assert.equal(own?.tokensUsed, 7);
  assert.equal(f.receiptCount(), 2);
});

test("a fork retains the Goal snapshot but does not copy a parent's physical billing receipts", async (t) => {
  const store = await memoryStore(t);
  await store.createSession(sessionInput());
  await store.createSession(sessionInput(CHILD_ID));
  const goal = await store.setTarget({ sessionID: SESSION_ID, objective: "Synthetic fork Goal." });
  const parent = await store.accountTargetUsage({
    sessionID: SESSION_ID,
    targetID: goal.targetID,
    usageID: PHYSICAL,
    tokensUsedDelta: 12,
  });
  assert.ok(parent);
  const child = await store.cloneTargetForFork({
    sessionID: CHILD_ID,
    source: parent,
    status: "active",
  });
  assert.equal(child.tokensUsed, 12);
  assert.equal(child.targetID, parent.targetID);
  const own = await store.accountTargetUsage({
    sessionID: CHILD_ID,
    targetID: child.targetID,
    usageID: PHYSICAL,
    tokensUsedDelta: 5,
  });
  assert.equal(own?.tokensUsed, 17);
  assert.equal((await store.readTarget({ sessionID: SESSION_ID }))?.tokensUsed, 12);
});

test("cold reopen and model ledger pruning preserve the persistent Goal receipt", async () => {
  const directory = await createProjectTestFixture("native-goal-receipt-cold");
  const dbPath = await assertProjectPath(join(directory, "session.sqlite"));
  const initial = await createSqliteSessionStore({ dbPath });
  let targetID: string;
  try {
    await initial.createSession(sessionInput());
    targetID = (
      await initial.setTarget({ sessionID: SESSION_ID, objective: "Cold synthetic Goal." })
    ).targetID;
    await initial.recordModelUsage({
      id: PHYSICAL,
      logicalRequestId: "receipt-physical",
      attemptIndex: 0,
      sessionID: SESSION_ID,
      querySource: "native_context_maintenance",
      providerId: "fixture-provider",
      modelId: "fixture-model",
      agent: "fixture",
      mode: "build",
      taskType: "interactive",
      status: "completed",
      startedAt: 1,
      completedAt: 2,
      inputTokens: 40,
      outputTokens: 8,
    });
    await initial.accountTargetUsage({
      sessionID: SESSION_ID,
      targetID,
      usageID: PHYSICAL,
      tokensUsedDelta: 48,
    });
    await initial.pruneUsage({ beforeTime: Date.now() });
    assert.equal((await initial.queryTaskUsage({ sessionID: SESSION_ID })).modelRequestCount, 0);
  } finally {
    initial.close();
  }
  const reopened = await createSqliteSessionStore({ dbPath });
  try {
    assert.deepEqual(reopened.migrationResult.applied, []);
    const goal = await reopened.accountTargetUsage({
      sessionID: SESSION_ID,
      targetID: targetID!,
      usageID: PHYSICAL,
      tokensUsedDelta: 48,
    });
    assert.equal(goal?.tokensUsed, 48);
  } finally {
    reopened.close();
  }
});

test("session deletion cascades receipts while deleting the current Goal alone keeps paid receipts", async (t) => {
  const f = await receiptDatabase(t);
  f.account();
  f.db.prepare("delete from session_target where session_id=?").run(SESSION_ID);
  assert.equal(f.receiptCount(), 1);
  f.db.prepare("delete from session where id=?").run(SESSION_ID);
  assert.equal(f.receiptCount(), 0);
  assert.deepEqual(f.db.prepare("pragma foreign_key_check").all(), []);
});
