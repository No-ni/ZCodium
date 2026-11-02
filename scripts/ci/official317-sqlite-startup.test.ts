import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { assertProjectPath, createProjectTestFixture } from "./project-test-sandbox.mjs";

async function storage() {
  return import("../../apps/zcode-cli/packages/adapters/src/storage/session-store/sqlite-session-store.js");
}

function tableHashes(db: DatabaseSync) {
  return new Map(
    db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map(({ name }) => {
        const table = String(name);
        assert.match(table, /^[a-z_]+$/);
        const rows = db
          .prepare(`SELECT * FROM "${table}"`)
          .all()
          .map((row) => JSON.stringify(row))
          .sort();
        return [table, createHash("sha256").update(JSON.stringify(rows)).digest("hex")];
      }),
  );
}

test("CLI startup returns the real migration result, then reopens without applying it again", async () => {
  const { SqliteSessionStore } = await storage();
  const fixture = await createProjectTestFixture("cli-startup-result");
  const dbPath = await assertProjectPath(join(fixture, "db.sqlite"));
  const store = await SqliteSessionStore.openStartup({ dbPath });
  try {
    assert.ok(store.migrationResult.applied.includes("0023_session_soft_delete_outcome"));
    assert.ok(store.migrationResult.applied.includes("0024_session_database_identity"));
    assert.equal(store.migrationResult.backupSkipped, false);
  } finally {
    store.close();
  }
  const reopened = await SqliteSessionStore.openStartup({ dbPath });
  try {
    assert.deepEqual(reopened.migrationResult, { applied: [], backupSkipped: false });
  } finally {
    reopened.close();
  }
});

test("repair migration backs up its real touched table and preserves every unrelated table hash", async () => {
  const { SqliteSessionStore } = await storage();
  const fixture = await createProjectTestFixture("cli-repair-tables");
  const dbPath = await assertProjectPath(join(fixture, "db.sqlite"));
  const first = await SqliteSessionStore.openStartup({ dbPath });
  first.close();
  const db = new DatabaseSync(dbPath);
  let before: Map<string, string>;
  try {
    db.prepare(
      "INSERT INTO session(id, project_id, slug, directory, title, version, time_created, time_updated) VALUES(?,?,?,?,?,?,?,?)",
    ).run("fixture", "synthetic", "fixture", "/synthetic", "Fixture", "old", 1, 2);
    db.prepare(
      "INSERT INTO session_entry(id,session_id,type,time_created,time_updated,data) VALUES(?,?,?,?,?,?)",
    ).run("selection", "fixture", "runtime/model_selection", 1, 2, "{");
    db.prepare("DELETE FROM schema_migration WHERE id=?").run(
      "0023_repair_invalid_model_selection",
    );
    before = tableHashes(db);
  } finally {
    db.close();
  }
  const upgraded = await SqliteSessionStore.openStartup({ dbPath });
  let backupPath: string;
  try {
    assert.deepEqual(upgraded.migrationResult.applied, ["0023_repair_invalid_model_selection"]);
    assert.equal(upgraded.migrationResult.backupSkipped, false);
    assert.ok(upgraded.migrationResult.backupPath);
    backupPath = await assertProjectPath(upgraded.migrationResult.backupPath);
  } finally {
    upgraded.close();
  }
  const metadata = JSON.parse(await readFile(join(backupPath, "backup.json"), "utf8"));
  assert.deepEqual(metadata.tables.map((table: { name: string }) => table.name).sort(), [
    "schema_migration",
    "session_entry",
  ]);
  const after = new DatabaseSync(dbPath);
  try {
    const hashes = tableHashes(after);
    assert.deepEqual([...hashes.keys()], [...before.keys()]);
    for (const [table, hash] of before) {
      if (table === "schema_migration" || table === "session_entry") continue;
      assert.equal(hashes.get(table), hash, `Unrelated table changed: ${table}`);
    }
    assert.notEqual(hashes.get("session_entry"), before.get("session_entry"));
  } finally {
    after.close();
  }
});

test("cancelled startup rolls back and closes its handle before a successful retry", async () => {
  const { SqliteSessionStore } = await storage();
  const fixture = await createProjectTestFixture("cli-startup-cancel");
  const dbPath = await assertProjectPath(join(fixture, "db.sqlite"));
  const controller = new AbortController();
  await assert.rejects(
    SqliteSessionStore.openStartup(
      { dbPath },
      {
        signal: controller.signal,
        onProgress(state) {
          if (state.phase === "migrating") controller.abort();
        },
      },
    ),
  );
  const db = new DatabaseSync(dbPath, { timeout: 0 });
  try {
    db.exec("BEGIN EXCLUSIVE");
    assert.equal(
      db.prepare("SELECT name FROM sqlite_schema WHERE name='schema_migration'").get(),
      undefined,
    );
    db.exec("ROLLBACK");
  } finally {
    db.close();
  }
  const retry = await SqliteSessionStore.openStartup({ dbPath });
  try {
    assert.ok(retry.migrationResult.applied.length > 0);
  } finally {
    retry.close();
  }
});
