import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  NATIVE_CONTEXT_COMPRESSION_MIGRATION,
  NATIVE_CONTEXT_COMPRESSION_TABLES,
  NATIVE_CONTEXT_GOAL_USAGE_RECEIPT_MIGRATION,
} from "../src/storage/session-store/native-context-compression/index.js";
import { SQLITE_MIGRATIONS } from "../src/storage/session-store/migrations.js";
import { SESSION_DATABASE_MIGRATIONS } from "../src/storage/session-store/migration-contract.js";
import { runSqliteSessionMigrationsAsync } from "../src/storage/session-store/migration-runner.js";
import { assertSessionDatabaseSchema } from "../src/storage/session-store/migration-schema.js";
import { createSession } from "../src/storage/session-store/repositories/sessions.js";
import { sessionInput } from "./fixtures/native-context-store.js";

const legacy = SQLITE_MIGRATIONS.filter(
  (step) =>
    step.id !== NATIVE_CONTEXT_COMPRESSION_MIGRATION.id &&
    step.id !== NATIVE_CONTEXT_GOAL_USAGE_RECEIPT_MIGRATION.id,
);
const checksumsUrl = new URL("./fixtures/native-context-old-checksums.json", import.meta.url);
const baselineUrl = new URL("../src/storage/session-store/schema.baseline.sql", import.meta.url);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

function seededLegacyDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("pragma foreign_keys=on");
  db.exec(
    "create table schema_migration(id text primary key, checksum text not null, app_version text, time_applied integer not null)",
  );
  for (const step of legacy) {
    db.exec(step.sql);
    db.prepare("insert into schema_migration values(?,?,?,?)").run(
      step.id,
      hash(step.sql.trim()),
      step.appVersion,
      1,
    );
  }
  const session = createSession(db, sessionInput());
  db.prepare(
    "insert into message(id,session_id,sequence,time_created,time_updated,data) values(?,?,?,?,?,?)",
  ).run("legacy-message", session.id, 0, 1, 1, '{"historical":"raw-message"}');
  db.prepare(
    "insert into part(id,message_id,session_id,sequence,time_created,time_updated,data) values(?,?,?,?,?,?,?)",
  ).run("legacy-part", "legacy-message", session.id, 0, 1, 1, '{"historical":"raw-part"}');
  db.prepare(
    "insert into local_setting(scope,scope_id,namespace,key,value,schema_version,time_created,time_updated) values(?,?,?,?,?,?,?,?)",
  ).run("project", "legacy-project", "native-fixture", "setting", '{"sentinel":true}', 1, 1, 1);
  db.prepare(
    "insert into input_history(id,project_id,session_id,text,kind,time_created) values(?,?,?,?,?,?)",
  ).run("legacy-input", "legacy-project", session.id, "历史合成输入", "user", 1);
  db.prepare("insert into zcode_database_identity(scope,identity) values(?,?)").run(
    "source",
    "legacy-identity",
  );
  return db;
}

function tableHashes(db: DatabaseSync): Record<string, string> {
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

function nativeSchema(db: DatabaseSync) {
  return db
    .prepare(
      "select type,name,tbl_name,sql from sqlite_schema where tbl_name in (?,?,?) order by type,name",
    )
    .all(...NATIVE_CONTEXT_COMPRESSION_TABLES)
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

test("the 25 published migration checksums remain frozen and the native contract touches only three new tables", async () => {
  const frozen = JSON.parse(await readFile(checksumsUrl, "utf8"));
  assert.equal(frozen.length, 25);
  assert.deepEqual(
    legacy.map((step) => ({ id: step.id, checksum: hash(step.sql.trim()) })),
    frozen,
  );
  const added = SESSION_DATABASE_MIGRATIONS.find(
    (step) => step.id === NATIVE_CONTEXT_COMPRESSION_MIGRATION.id,
  )!;
  assert.deepEqual(added.touchedTables, NATIVE_CONTEXT_COMPRESSION_TABLES);
  assert.equal(added.checksum, hash(NATIVE_CONTEXT_COMPRESSION_MIGRATION.sql.trim()));
  assert.equal(new Set(SQLITE_MIGRATIONS.map((step) => step.id)).size, 27);
});

test("additive upgrade preserves every legacy table hash and ledger row; a repeat applies no migrations", async (t) => {
  const db = seededLegacyDatabase();
  t.after(() => db.close());
  const before = tableHashes(db);
  const oldLedger = db.prepare("select * from schema_migration order by id").all();
  const result = await runSqliteSessionMigrationsAsync(db, ":memory:", { backupDirectories: [] });
  assert.deepEqual(result.applied, [
    NATIVE_CONTEXT_COMPRESSION_MIGRATION.id,
    NATIVE_CONTEXT_GOAL_USAGE_RECEIPT_MIGRATION.id,
  ]);
  const after = tableHashes(db);
  assert.deepEqual(
    Object.fromEntries(Object.keys(before).map((table) => [table, after[table]])),
    before,
  );
  assert.deepEqual(
    Object.keys(after)
      .filter((table) => !(table in before))
      .sort(),
    [...NATIVE_CONTEXT_COMPRESSION_TABLES, "session_target_usage_receipt"].sort(),
  );
  assert.deepEqual(
    db
      .prepare("select * from schema_migration where id not in (?,?) order by id")
      .all(NATIVE_CONTEXT_COMPRESSION_MIGRATION.id, NATIVE_CONTEXT_GOAL_USAGE_RECEIPT_MIGRATION.id),
    oldLedger,
  );
  assert.deepEqual(db.prepare("pragma foreign_key_check").all(), []);
  assertSessionDatabaseSchema(db);
  const ledger = db.prepare("select * from schema_migration order by id").all();
  assert.deepEqual(
    (await runSqliteSessionMigrationsAsync(db, ":memory:", { backupDirectories: [] })).applied,
    [],
  );
  assert.deepEqual(db.prepare("select * from schema_migration order by id").all(), ledger);
});

test("schema baseline matches migrated native tables and the guard rejects a lost native foreign key", async (t) => {
  const upgraded = seededLegacyDatabase();
  const baseline = new DatabaseSync(":memory:");
  t.after(() => upgraded.close());
  t.after(() => baseline.close());
  await runSqliteSessionMigrationsAsync(upgraded, ":memory:", { backupDirectories: [] });
  baseline.exec(await readFile(baselineUrl, "utf8"));
  assert.deepEqual(nativeSchema(baseline), nativeSchema(upgraded));
  assertSessionDatabaseSchema(baseline);
  baseline.exec("drop table native_context_state");
  baseline.exec(
    "create table native_context_state(session_id text primary key,revision integer,generation integer,history_version text,data text)",
  );
  assert.throws(
    () => assertSessionDatabaseSchema(baseline),
    (error: unknown) => {
      assert.equal((error as { kind: string }).kind, "schema_incompatible");
      return true;
    },
  );
});
