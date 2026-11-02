import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { assertProjectPath, createProjectTestFixture } from "./project-test-sandbox.mjs";
import { projectStorage } from "../../packages/services/src/project-storage/index.js";
import { runTasksDatabaseMigrations } from "../../packages/services/src/session/tasksDatabase/migrations.js";

test("Project startup uses the existing journal and reopens without reapplying migrations", async () => {
  const fixture = await createProjectTestFixture("project-journal");
  const dbPath = await assertProjectPath(join(fixture, "tasks.sqlite"));
  let db = new DatabaseSync(dbPath);
  const context = { backupDirectories: [fixture], now: () => 1000 };
  try {
    await runTasksDatabaseMigrations(db, { dbPath });
    const first = await projectStorage.migrate(db, context);
    assert.deepEqual(first.applied, [
      "0005_projects",
      "0006_default_workspace_tasks",
      "0007_initial_workspace_order",
      "0008_remote_entry_deleted_cache",
      "0009_session_creation_commands",
    ]);
    assert.equal(
      db
        .prepare(
          "SELECT time_applied FROM schema_migration WHERE id='0006_default_workspace_tasks'",
        )
        .get()?.time_applied,
      1000,
    );
    db.close();
    db = new DatabaseSync(dbPath);
    assert.deepEqual(await projectStorage.migrate(db, context), {
      applied: [],
      backupSkipped: false,
    });
  } finally {
    db.close();
  }
});

test("Default project correction preserves task facts and every unrelated table", async () => {
  const fixture = await createProjectTestFixture("project-correction");
  const dbPath = await assertProjectPath(join(fixture, "tasks.sqlite"));
  const db = new DatabaseSync(dbPath);
  const context = { backupDirectories: [fixture], now: () => 1000 };
  const hashes = () =>
    new Map(
      db
        .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all()
        .map(({ name }) => {
          const table = String(name);
          const rows = db
            .prepare('SELECT * FROM "' + table.replaceAll('"', '""') + '" ORDER BY rowid')
            .all();
          return [table, createHash("sha256").update(JSON.stringify(rows)).digest("hex")];
        }),
    );
  try {
    await runTasksDatabaseMigrations(db, { dbPath });
    await projectStorage.migrate(db, context);
    // 模拟已发布 0005 账本与尚未应用 0006 的旧组织库，保留全部其他迁移及事实。
    db.exec("DELETE FROM schema_migration WHERE id='0006_default_workspace_tasks'");
    const insert = db.prepare(
      "INSERT INTO projects(project_id,host_id,name,name_overridden,position,created_at,updated_at) VALUES(?,'local',?,?,0,?,?)",
    );
    for (const [id, overridden, created, updated] of [
      ["candidate", 0, 100, 100],
      ["edited", 0, 100, 101],
      ["named", 1, 100, 100],
      ["later", 0, 1001, 1001],
      ["multiple", 0, 100, 100],
    ] as const) {
      insert.run(id, id, overridden, created, updated);
      db.prepare("INSERT INTO project_roots VALUES(?,?,0,1)").run(
        id,
        "/synthetic/" + id + "/.zcode/workspace/default",
      );
    }
    db.prepare("INSERT INTO project_roots VALUES('multiple',?,1,0)").run("/synthetic/second");
    db.prepare(
      "INSERT INTO tasks(workspace_key,workspace_path,task_id,title,created_at,updated_at,host_id,root_path,project_id,handoff_pending,cli_title,cli_title_source,cli_created_at,cli_updated_at,cli_deleted,pinned,archived,unread_at) VALUES('fixture','/synthetic/cwd','task','title',10,20,'local','/synthetic/cwd','candidate',8,'title','default',10,20,0,1,1,30)",
    ).run();
    const beforeTask = db.prepare("SELECT * FROM tasks").get();
    const before = hashes();
    await projectStorage.migrate(db, context);
    assert.deepEqual(
      { ...db.prepare("SELECT * FROM tasks").get() },
      { ...beforeTask, project_id: null },
    );
    assert.equal(
      db.prepare("SELECT deleted FROM projects WHERE project_id='candidate'").get()?.deleted,
      1,
    );
    assert.equal(
      db
        .prepare(
          "SELECT count(*) AS count FROM projects WHERE project_id<>'candidate' AND deleted=1",
        )
        .get()?.count,
      0,
    );
    for (const [table, hash] of hashes())
      if (!["tasks", "projects", "schema_migration"].includes(table))
        assert.equal(hash, before.get(table), table);
    const after = hashes();
    await projectStorage.migrate(db, context);
    assert.deepEqual(hashes(), after);
  } finally {
    db.close();
  }
});
