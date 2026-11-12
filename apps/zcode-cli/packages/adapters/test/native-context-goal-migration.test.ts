import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  NATIVE_CONTEXT_COMPRESSION_MIGRATION,
  NATIVE_CONTEXT_GOAL_USAGE_RECEIPT_MIGRATION,
} from "../src/storage/session-store/native-context-compression/index.js";
import { SQLITE_MIGRATIONS } from "../src/storage/session-store/migrations.js";
import { SESSION_DATABASE_MIGRATIONS } from "../src/storage/session-store/migration-contract.js";
import { runSqliteSessionMigrationsAsync } from "../src/storage/session-store/migration-runner.js";
import { assertSessionDatabaseSchema } from "../src/storage/session-store/migration-schema.js";
import { createSession } from "../src/storage/session-store/repositories/sessions.js";
import { setSessionTarget } from "../src/storage/session-target.js";
import { sessionInput } from "./fixtures/native-context-store.js";

const legacy = SQLITE_MIGRATIONS.filter(
  (step) => step.id !== NATIVE_CONTEXT_GOAL_USAGE_RECEIPT_MIGRATION.id,
);
const hash = (sql: string) => createHash("sha256").update(sql.trim()).digest("hex");
const baseline = new URL("../src/storage/session-store/schema.baseline.sql", import.meta.url);

function oldDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec("pragma foreign_keys=on");
  db.exec(
    "create table schema_migration(id text primary key,checksum text not null,app_version text,time_applied integer not null)",
  );
  for (const step of legacy) {
    db.exec(step.sql);
    db.prepare("insert into schema_migration values(?,?,?,?)").run(
      step.id,
      hash(step.sql),
      step.appVersion,
      1,
    );
  }
  const session = createSession(db, sessionInput());
  const goal = setSessionTarget(db, {
    sessionID: session.id,
    objective: "Synthetic migrated Goal.",
    status: "paused",
    tokenBudget: 100,
  });
  db.prepare("update session_target set tokens_used=12 where target_id=?").run(goal.targetID);
  return db;
}

function tableHashes(db: DatabaseSync) {
  const rows = db
    .prepare(
      "select name from sqlite_schema where type='table' and name not like 'sqlite_%' and name<>'schema_migration' order by name",
    )
    .all() as { name: string }[];
  return Object.fromEntries(
    rows.map(({ name }) => {
      assert.match(name, /^[A-Za-z_][A-Za-z0-9_]*$/);
      const contents = db
        .prepare("select * from " + name)
        .all()
        .map((row) => JSON.stringify(row))
        .sort();
      return [name, hash(contents.join("\n"))];
    }),
  );
}

function receiptSchema(db: DatabaseSync) {
  return db
    .prepare(
      "select type,name,tbl_name,sql from sqlite_schema where tbl_name='session_target_usage_receipt' order by type,name",
    )
    .all()
    .map((row) => ({
      ...row,
      sql:
        typeof row.sql === "string"
          ? row.sql
              .replace(/\bif\s+not\s+exists\b/gi, "")
              .replace(/\s+/g, " ")
              .trim()
              .toLowerCase()
          : row.sql,
    }));
}

test("Goal billing appends one migration without rewriting the 25 old SQL checksums or native 0024", async () => {
  const frozen = JSON.parse(
    await readFile(
      new URL("./fixtures/native-context-old-checksums.json", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(
    legacy
      .filter((step) => step.id !== NATIVE_CONTEXT_COMPRESSION_MIGRATION.id)
      .map((step) => ({ id: step.id, checksum: hash(step.sql) })),
    frozen,
  );
  assert.equal(
    hash(NATIVE_CONTEXT_COMPRESSION_MIGRATION.sql),
    "8cd366295df8e2aceb8582f09aa73f3b5de0e98fe969033625a72e7f709f0c79",
  );
  assert.equal(legacy.length, 26);
  assert.equal(new Set(SQLITE_MIGRATIONS.map((step) => step.id)).size, 27);
  const added = SESSION_DATABASE_MIGRATIONS.find(
    (step) => step.id === NATIVE_CONTEXT_GOAL_USAGE_RECEIPT_MIGRATION.id,
  )!;
  assert.deepEqual(added.touchedTables, ["session_target_usage_receipt"]);
  assert.equal(added.checksum, hash(NATIVE_CONTEXT_GOAL_USAGE_RECEIPT_MIGRATION.sql));
});

test("receipt upgrade preserves every existing row and ledger and replay applies no migration", async (t) => {
  const db = oldDatabase();
  t.after(() => db.close());
  const before = tableHashes(db);
  const ledger = db.prepare("select * from schema_migration order by id").all();
  assert.deepEqual(
    (await runSqliteSessionMigrationsAsync(db, ":memory:", { backupDirectories: [] })).applied,
    [NATIVE_CONTEXT_GOAL_USAGE_RECEIPT_MIGRATION.id],
  );
  const after = tableHashes(db);
  assert.deepEqual(
    Object.fromEntries(Object.keys(before).map((table) => [table, after[table]])),
    before,
  );
  assert.deepEqual(
    Object.keys(after).filter((table) => !(table in before)),
    ["session_target_usage_receipt"],
  );
  assert.deepEqual(
    db
      .prepare("select * from schema_migration where id<>? order by id")
      .all(NATIVE_CONTEXT_GOAL_USAGE_RECEIPT_MIGRATION.id),
    ledger,
  );
  assert.deepEqual(db.prepare("pragma foreign_key_check").all(), []);
  assertSessionDatabaseSchema(db);
  assert.deepEqual(
    (await runSqliteSessionMigrationsAsync(db, ":memory:", { backupDirectories: [] })).applied,
    [],
  );
});

test("the receipt baseline matches upgrade and the guard requires the session cascade", async (t) => {
  const upgraded = oldDatabase();
  const fresh = new DatabaseSync(":memory:");
  t.after(() => upgraded.close());
  t.after(() => fresh.close());
  await runSqliteSessionMigrationsAsync(upgraded, ":memory:", { backupDirectories: [] });
  fresh.exec(await readFile(baseline, "utf8"));
  assert.deepEqual(receiptSchema(fresh), receiptSchema(upgraded));
  assertSessionDatabaseSchema(fresh);
  fresh.exec("drop table session_target_usage_receipt");
  fresh.exec(
    "create table session_target_usage_receipt(session_id text,target_id text,usage_id text,tokens_used_delta integer,time_used_seconds_delta integer,time_accounted integer,primary key(session_id,target_id,usage_id))",
  );
  assert.throws(
    () => assertSessionDatabaseSchema(fresh),
    (error: unknown) => {
      assert.equal((error as { kind: string }).kind, "schema_incompatible");
      return true;
    },
  );
});
