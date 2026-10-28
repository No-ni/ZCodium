import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { migrate, restore } from "./index.js";
import type { SqliteMigration } from "./contract.js";

const sql = "UPDATE items SET value='new'";
const step: SqliteMigration = {
  id: "0001_fixture",
  appVersion: "3.16.2",
  sql,
  touchedTables: ["items"],
};
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "zcodium-migration-test-"));
  const path = join(root, "tasks.sqlite");
  const db = new DatabaseSync(path);
  const connections = [db];
  db.exec(
    "CREATE TABLE items(id TEXT PRIMARY KEY,value TEXT); INSERT INTO items VALUES('one','old')",
  );
  // Windows 不允许删除仍被 SQLite 连接持有的文件；先关闭所有连接，再清理唯一临时根。
  t.after(async () => {
    for (const connection of connections.toReversed()) if (connection.isOpen) connection.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    path,
    db,
    connections,
    options: { database: "tasks", backupDirectories: [join(root, "backups")] },
  };
}

test("legacy JSON checksum remains accepted, SQL migrations apply once and restore ledger", async (t) => {
  const f = await fixture(t);
  const checksum = createHash("sha256")
    .update(JSON.stringify(["frozen-json-v1"]))
    .digest("hex");
  f.db.exec(
    "CREATE TABLE tasks_schema_migration(id TEXT PRIMARY KEY,checksum TEXT NOT NULL,time_applied INTEGER NOT NULL)",
  );
  f.db.prepare("INSERT INTO tasks_schema_migration VALUES(?,?,?)").run("0000_legacy", checksum, 1);
  const legacy = {
    ...step,
    id: "0000_legacy",
    checksum,
    sql: "legacy TS conversion",
    apply: () => assert.fail("already applied"),
  };
  const result = await migrate(f.db, [legacy, step], {
    ...f.options,
    journalTable: "tasks_schema_migration",
  });
  assert.deepEqual(result.applied, [step.id]);
  assert.equal(f.db.prepare("SELECT value FROM items").get()!.value, "new");
  assert.deepEqual(
    (await migrate(f.db, [legacy, step], { ...f.options, journalTable: "tasks_schema_migration" }))
      .applied,
    [],
  );
  await restore(f.db, result.backupPath!, { database: "tasks", writersStopped: true });
  assert.equal(f.db.prepare("SELECT value FROM items").get()!.value, "old");
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM tasks_schema_migration").get()!.n, 1);
  assert.equal(
    f.db.prepare("SELECT checksum FROM tasks_schema_migration").get()!.checksum,
    checksum,
  );
});

test("backup failure blocks migration before changing old rows or ledger", async (t) => {
  const f = await fixture(t);
  const blocked = join(f.root, "file-not-directory");
  await writeFile(blocked, "fixture");
  await assert.rejects(
    migrate(f.db, [step], { ...f.options, backupDirectories: [blocked] }),
    (error: any) => error.kind === "backup_failed",
  );
  assert.equal(f.db.prepare("SELECT value FROM items").get()!.value, "old");
  assert.equal(
    f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='schema_migration'").get(),
    undefined,
  );
});

test("missing touchedTables and altered legacy checksum reject before SQL writes", async (t) => {
  const f = await fixture(t);
  await assert.rejects(migrate(f.db, [{ ...step, touchedTables: [] }], f.options));
  const first = await migrate(f.db, [step], f.options);
  await assert.rejects(
    migrate(f.db, [{ ...step, sql: "changed" }], f.options),
    (error: any) => error.kind === "checksum_mismatch",
  );
  assert.ok(first.backupPath);
});

test("two connections serialize while asynchronous backup yields and lock rechecks ledger", async (t) => {
  const f = await fixture(t);
  const second = new DatabaseSync(f.path);
  f.connections.push(second);
  let release!: () => void;
  let reached!: () => void;
  const waiting = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const first = migrate(f.db, [step], {
    ...f.options,
    onBeforeApply: async () => {
      reached();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  });
  await waiting;
  const next = migrate(second, [step], f.options);
  let ticked = false;
  await new Promise<void>((resolve) =>
    setImmediate(() => {
      ticked = true;
      resolve();
    }),
  );
  assert.equal(ticked, true);
  release();
  assert.deepEqual((await first).applied, [step.id]);
  assert.deepEqual((await next).applied, []);
});

test("tampered backup and changed schema cannot restore or damage the active database", async (t) => {
  const f = await fixture(t);
  const result = await migrate(f.db, [step], f.options);
  const metadataPath = join(result.backupPath!, "backup.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  const original = JSON.stringify(metadata);
  metadata.tables.find((table: any) => table.name === "items").hash = "0".repeat(64);
  await writeFile(metadataPath, JSON.stringify(metadata));
  await assert.rejects(
    restore(f.db, result.backupPath!, { database: "tasks", writersStopped: true }),
  );
  assert.equal(f.db.prepare("SELECT value FROM items").get()!.value, "new");
  await writeFile(metadataPath, original);
  f.db.exec("ALTER TABLE items ADD COLUMN extra TEXT");
  await assert.rejects(
    restore(f.db, result.backupPath!, { database: "tasks", writersStopped: true }),
  );
  assert.equal(f.db.prepare("SELECT value FROM items").get()!.value, "new");
});

test("metadata table omission and rewritten schema fail closed before restore writes", async (t) => {
  const f = await fixture(t);
  const result = await migrate(f.db, [step], f.options);
  const metadataPath = join(result.backupPath!, "backup.json");
  const original = JSON.parse(await readFile(metadataPath, "utf8"));
  for (const mutate of [
    (metadata: typeof original) => {
      metadata.tables = metadata.tables.filter((table: { name: string }) => table.name !== "items");
    },
    (metadata: typeof original) => {
      metadata.tables.push({ ...metadata.tables[0] });
    },
    (metadata: typeof original) => {
      metadata.migrations = [];
    },
    (metadata: typeof original) => {
      f.db.exec("ALTER TABLE items ADD COLUMN extra TEXT");
      metadata.tables.find((table: { name: string }) => table.name === "items").schema = String(
        f.db.prepare("SELECT sql FROM sqlite_master WHERE name='items'").get()!.sql,
      );
    },
  ]) {
    const metadata = structuredClone(original);
    mutate(metadata);
    await writeFile(metadataPath, JSON.stringify(metadata));
    await assert.rejects(
      restore(f.db, result.backupPath!, { database: "tasks", writersStopped: true }),
    );
    assert.equal(f.db.prepare("SELECT value FROM items").get()!.value, "new");
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM schema_migration").get()!.n, 1);
  }
});

test("restore preserves foreign keys, original ledger absence and connection pragmas", async (t) => {
  const f = await fixture(t);
  f.db.exec(
    "PRAGMA foreign_keys=ON; PRAGMA busy_timeout=4321; CREATE TABLE children(id TEXT PRIMARY KEY,item_id TEXT REFERENCES items(id) ON DELETE CASCADE); INSERT INTO children VALUES('child','one')",
  );
  const result = await migrate(f.db, [step], f.options);
  assert.equal(f.db.prepare("PRAGMA busy_timeout").get()!.timeout, 4321);
  await restore(f.db, result.backupPath!, { database: "tasks", writersStopped: true });
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM children").get()!.n, 1);
  assert.equal(f.db.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1);
  assert.equal(f.db.prepare("PRAGMA busy_timeout").get()!.timeout, 4321);
  assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(
    f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='schema_migration'").get(),
    undefined,
  );
});

test("restore foreign key failure rolls back rows and ledger and restores pragmas", async (t) => {
  const f = await fixture(t);
  f.db.exec(
    "PRAGMA foreign_keys=ON; PRAGMA busy_timeout=2345; CREATE TABLE parents(id TEXT PRIMARY KEY); INSERT INTO parents VALUES('old'),('new'); CREATE TABLE refs(id TEXT PRIMARY KEY,parent_id TEXT REFERENCES parents(id)); INSERT INTO refs VALUES('ref','old')",
  );
  const change: SqliteMigration = {
    ...step,
    touchedTables: ["refs"],
    sql: "UPDATE refs SET parent_id='new'",
  };
  const result = await migrate(f.db, [change], f.options);
  f.db.exec("DELETE FROM parents WHERE id='old'");
  await assert.rejects(
    restore(f.db, result.backupPath!, { database: "tasks", writersStopped: true }),
  );
  assert.equal(f.db.prepare("SELECT parent_id FROM refs").get()!.parent_id, "new");
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM schema_migration").get()!.n, 1);
  assert.equal(f.db.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1);
  assert.equal(f.db.prepare("PRAGMA busy_timeout").get()!.timeout, 2345);
  assert.equal(f.db.isTransaction, false);
});

test("strict touchedTables and globally unambiguous ledger ids reject without side effects", async (t) => {
  const f = await fixture(t);
  const invalidTables: unknown[] = [
    undefined,
    [],
    [""],
    ["bad;table"],
    [42],
    ["items", "items"],
    ["schema_migration"],
    ["sqlite_sequence"],
  ];
  for (const touchedTables of invalidTables) {
    await assert.rejects(migrate(f.db, [{ ...step, touchedTables } as SqliteMigration], f.options));
    assert.equal(
      f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='schema_migration'").get(),
      undefined,
    );
  }
  await assert.rejects(
    migrate(f.db, [step, { ...step, id: "0002_next", previousIds: [step.id] }], f.options),
  );
  await assert.rejects(migrate(f.db, [{ ...step, previousIds: [step.id] }], f.options));
  assert.equal(f.db.prepare("SELECT value FROM items").get()!.value, "old");
});

test("metadata-only schema changes reject restore rather than claim DDL downgrade", async (t) => {
  const f = await fixture(t);
  const result = await migrate(f.db, [step], f.options);
  f.db.exec(
    "CREATE TRIGGER changed_schema AFTER INSERT ON items BEGIN UPDATE items SET value='trigger'; END",
  );
  await assert.rejects(
    restore(f.db, result.backupPath!, { database: "tasks", writersStopped: true }),
  );
  assert.equal(f.db.prepare("SELECT value FROM items").get()!.value, "new");
});

test("transaction ownership mismatch does not roll back a caller transaction", async (t) => {
  const f = await fixture(t);
  f.db.exec("BEGIN IMMEDIATE; UPDATE items SET value='caller'");
  await assert.rejects(migrate(f.db, [step], f.options));
  assert.equal(f.db.isTransaction, true);
  assert.equal(f.db.prepare("SELECT value FROM items").get()!.value, "caller");
  await assert.rejects(
    migrate(f.db, [{ ...step, touchedTables: [] }], { ...f.options, transactionOpen: true }),
  );
  assert.equal(f.db.isTransaction, true);
  f.db.exec("ROLLBACK");
  assert.equal(f.db.prepare("SELECT value FROM items").get()!.value, "old");
});
