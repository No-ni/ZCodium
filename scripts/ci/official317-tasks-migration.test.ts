import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { assertProjectPath, createProjectTestFixture } from "./project-test-sandbox.mjs";

async function migrations() {
  return import("../../packages/services/src/session/tasksDatabase/migrations.js");
}

test("Host scoped migration uses its single async runner and validates the current base schema", async () => {
  const {
    runTasksDatabaseMigrations,
    areTasksDatabaseMigrationsApplied,
    inspectTasksMigrationKind,
  } = await migrations();
  const fixture = await createProjectTestFixture("tasks-scoped-migrate");
  const dbPath = await assertProjectPath(join(fixture, "tasks.sqlite"));
  const db = new DatabaseSync(dbPath);
  const phases: string[] = [];
  try {
    assert.equal(inspectTasksMigrationKind(db), "initialize");
    const first = await runTasksDatabaseMigrations(db, {
      dbPath,
      onProgress: (phase) => phases.push(phase),
    });
    assert.ok(first.applied.includes("0006_task_group_admissions"));
    assert.equal(first.backupSkipped, false);
    assert.equal(phases.at(-1), "committing");
    assert.equal(areTasksDatabaseMigrationsApplied(db), true);
    assert.deepEqual(await runTasksDatabaseMigrations(db, { dbPath }), {
      applied: [],
      backupSkipped: false,
    });
    const scope = await runTasksDatabaseMigrations(db, { dbPath, scope: "controller-remote" });
    assert.deepEqual(scope.applied, ["0004_controller_remote_identity"]);
    assert.equal(areTasksDatabaseMigrationsApplied(db, "controller-remote"), true);
    assert.equal(areTasksDatabaseMigrationsApplied(db), true);
    db.prepare("INSERT INTO tasks_schema_migration VALUES(?,?,?)").run(
      "9999_unknown_fixture",
      "0".repeat(64),
      1,
    );
    assert.throws(() => areTasksDatabaseMigrationsApplied(db), { kind: "schema_incompatible" });
    db.prepare("DELETE FROM tasks_schema_migration WHERE id=?").run("9999_unknown_fixture");
    const original = db
      .prepare("SELECT checksum FROM tasks_schema_migration WHERE id=?")
      .get("0004_controller_remote_identity")!;
    db.prepare("UPDATE tasks_schema_migration SET checksum=? WHERE id=?").run(
      "0".repeat(64),
      "0004_controller_remote_identity",
    );
    assert.throws(() => areTasksDatabaseMigrationsApplied(db), { kind: "checksum_mismatch" });
    db.prepare("UPDATE tasks_schema_migration SET checksum=? WHERE id=?").run(
      original.checksum,
      "0004_controller_remote_identity",
    );
    db.exec("ALTER TABLE tasks DROP COLUMN task_status");
    assert.throws(() => areTasksDatabaseMigrationsApplied(db), { kind: "schema_incompatible" });
    await assert.rejects(runTasksDatabaseMigrations(db, { dbPath }), {
      kind: "schema_incompatible",
    });
  } finally {
    db.close();
  }
});

test("Host cancellation before commit rolls back migration and preserves a later retry", async () => {
  const { runTasksDatabaseMigrations } = await migrations();
  const fixture = await createProjectTestFixture("tasks-cancel-migrate");
  const dbPath = await assertProjectPath(join(fixture, "tasks.sqlite"));
  const db = new DatabaseSync(dbPath);
  const controller = new AbortController();
  try {
    await assert.rejects(
      runTasksDatabaseMigrations(db, {
        dbPath,
        signal: controller.signal,
        onProgress: () => controller.abort(),
      }),
    );
    assert.equal(db.isTransaction, false);
    assert.equal(
      db.prepare("SELECT name FROM sqlite_schema WHERE name='tasks_schema_migration'").get(),
      undefined,
    );
    assert.ok((await runTasksDatabaseMigrations(db, { dbPath })).applied.length > 0);
  } finally {
    db.close();
  }
});
