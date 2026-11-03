import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createProjectTestFixture } from "../project-test-sandbox.mjs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { tsImport } from "tsx/esm/api";

const exec = promisify(execFile);
const workspace = fileURLToPath(new URL("../../..", import.meta.url));
if (process.argv.includes("--update-reviewed-baseline")) {
  throw new Error("SQLITE_SCHEMA_BASELINE_UPDATE_NOT_SUPPORTED");
}
const { assertAdditiveSchema, dumpSqliteSchema } = await tsImport(
  "../../../packages/shared/src/sqlite-migrations/index.ts",
  import.meta.url,
);
const { runTasksDatabaseMigrations } = await tsImport(
  "../../../packages/services/src/session/tasksDatabase/migrations.ts",
  import.meta.url,
);
const { runSqliteSessionMigrationsAsync } = await tsImport(
  "../../../apps/zcode-cli/packages/adapters/src/storage/session-store/migration-runner.ts",
  import.meta.url,
);
const baselines = [
  {
    path: "packages/services/src/session/tasksDatabase/schema.baseline.sql",
    database: "tasks-index",
    initialize: (db, root) =>
      runTasksDatabaseMigrations(db, {
        dbPath: join(root, "fixture.sqlite"),
        backupDirectories: [join(root, "backup")],
      }),
  },
  {
    path: "apps/zcode-cli/packages/adapters/src/storage/session-store/schema.baseline.sql",
    database: "cli",
    initialize: (db, root) =>
      runSqliteSessionMigrationsAsync(db, join(root, "fixture.sqlite"), {
        backupDirectories: [join(root, "backup")],
      }),
  },
];

for (const baseline of baselines)
  test(`actual SQLite migration schema matches reviewed ${baseline.database} baseline`, async (t) => {
    const root = await createProjectTestFixture("sqlite-schema-baseline");
    const db = new DatabaseSync(join(root, "fixture.sqlite"));
    t.after(async () => {
      if (db.isOpen) db.close();
    });
    // 原因：旧夹具持有已退役数组和错误账本选项；验证必须复用实际启动 adapter。
    await baseline.initialize(db, root);
    const current = dumpSqliteSchema(db);
    assert.deepEqual((await baseline.initialize(db, root)).applied, []);
    assert.equal(dumpSqliteSchema(db), current, "reopening must not change the schema");
    const path = fileURLToPath(new URL(`../../../${baseline.path}`, import.meta.url));
    const objects = await exec("git", ["ls-tree", "--name-only", "HEAD", "--", baseline.path], {
      cwd: workspace,
    });
    if (objects.stdout.trim()) {
      // 基线来自真实 HEAD，修改本地快照不能绕过既有表/列/索引/外键的只增边界。
      const previous = (await exec("git", ["show", `HEAD:${baseline.path}`], { cwd: workspace }))
        .stdout;
      assertAdditiveSchema(previous, current);
    }
    let reviewed;
    try {
      reviewed = await readFile(path, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (reviewed) assertAdditiveSchema(reviewed, current);
    assert.equal(typeof reviewed, "string", "missing reviewed SQLite schema baseline");
    assertAdditiveSchema(current, reviewed);
    assert.equal(current, reviewed, "SQLite schema differs from the reviewed migration baseline");
  });
