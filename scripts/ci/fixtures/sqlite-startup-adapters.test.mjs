import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { createProjectTestFixture } from "../project-test-sandbox.mjs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
import { pathToFileURL } from "node:url";

// 历史分步 fixture 需要实际冻结合同，但该清单已不再是产品公开 API。
// 仅在项目沙箱中的源码副本追加测试导出，复用原 prepareMigrations，不恢复旧生产接口。
const hostSourceUrl = new URL(
  "../../../packages/services/src/session/tasksDatabase/migrations.ts",
  import.meta.url,
);
const hostFixtureRoot = await createProjectTestFixture("host-migration-contract");
const hostFixturePath = join(hostFixtureRoot, "migrations.ts");
const hostSource = (await readFile(hostSourceUrl, "utf8")).replace(
  /from "#src\/(.*?)\.js"/g,
  (_, path) =>
    `from "${new URL(`../../../packages/services/src/${path}.ts`, import.meta.url).href}"`,
);
await writeFile(
  hostFixturePath,
  `${hostSource}\nexport const TASKS_DATABASE_MIGRATIONS = prepareMigrations("base");\n`,
  { flag: "wx" },
);
const host = await tsImport(pathToFileURL(hostFixturePath).href, import.meta.url);
const cli = await tsImport(
  "../../../apps/zcode-cli/packages/adapters/src/storage/session-store/migration-runner.ts",
  import.meta.url,
);
const { SQLITE_MIGRATIONS } = await tsImport(
  "../../../apps/zcode-cli/packages/adapters/src/storage/session-store/migrations.ts",
  import.meta.url,
);
const { migrate, restore, dumpSqliteSchema, assertAdditiveSchema } = await tsImport(
  "../../../packages/shared/src/sqlite-migrations/index.ts",
  import.meta.url,
);
const { SESSION_DATABASE_MIGRATIONS } = await tsImport(
  "../../../apps/zcode-cli/packages/adapters/src/storage/session-store/migration-contract.ts",
  import.meta.url,
);
const { prepareTasksIndexStorage } = await tsImport(
  // 启动 owner 已迁入 project-storage，通过现公开入口验证，不恢复旧文件。
  "../../../packages/services/src/project-storage/startup-entry.ts",
  import.meta.url,
);
const { SqliteSessionStore } = await tsImport(
  "../../../apps/zcode-cli/packages/adapters/src/storage/session-store/sqlite-session-store.ts",
  import.meta.url,
);
const hostLedger = [
  ["0001_adopt_task_schema", "3e8337b015d94b05dd31a6003f3acc649e821794cfa288bc0af3022698bd4d17"],
  ["0002_provider_selection", "7244ef7c351f8d02750ab1953fff09f493a71befbf1b6e2d4bab726b0c6b48fc"],
  [
    "0003_official_glm_selection",
    "8987adb50ae412a46c294141c1af89ccfc252f22d41351bdf4c7528f56edc8b4",
  ],
  [
    "0004_project_execution_scopes",
    "caae5e91fc3abfeee6508f782890ad8d67cebeb80611775d39dc13a7e6fea3f0",
  ],
  [
    "0006_task_group_admissions",
    "0af559d04bb3f1a1dab12d6533d59292d232b09ea3ef3ef6ca3c9373bd663019",
  ],
];
const cliChecksums = [
  ["0001_base_session_store", "60e2d6a38ab36f31417c4f92c02690c96c7dcaaa0b6abe1741117d62a55c6462"],
  ["0002_local_setting", "22a6ada9325c9ad55a00a1f0ecf72332c63c1e89fc3d91fec8d155bb0058b465"],
  [
    "0003_backfill_permission_local_setting",
    "bd880375ba7b948c8bcda847e7eb52bc568d065bcba48190f6c3bfb14d11b7dc",
  ],
  ["0004_session_target", "df670752991c78e38e2f25b0a003abc0e9689bc8d4894351358f2f83335a3ae1"],
  [
    "0005_session_target_accounting",
    "6138ed4562dfdd5b571d39d3b62266c55dd9eb8f2f41948e046441a0e4a954cc",
  ],
  [
    "0006_input_history_attachments",
    "a2eab98649d738e15bdae27de7c5c114713f7777c55aa4111b19e03ee5ced54f",
  ],
  [
    "0007_workflow_script_runtime",
    "0068fc4bcaffe4de4669442a62eee227726e0e8e81b61c7458213a20ac596009",
  ],
  [
    "0008_workflow_definition_scope",
    "f7ee304e4005c291fb8883cfc180005263e6c6b2f94077487443f2c17a71d3eb",
  ],
  [
    "0009_session_title_metadata",
    "3855cf957177ae6319ae91866cdff59e946ca07a10b36b5b59689818bd13fe00",
  ],
  ["0010_usage_observability", "36918b0a98f465fe844097aa60c65ef73ea9c62cc266f02742bf3fc2cedf860b"],
  [
    "0011_session_target_summary_title",
    "2b7723479426a4e7a1ed9901ed817495c1bbf63e9547eb1c63cd9e24bf9305f8",
  ],
  ["0012_session_trace_id", "9dcef90998dd00c8ed1b22a2170e180eb15471b93947e65ebe101d41e96bdb60"],
  [
    "0013_session_target_active_run_accounting",
    "7ab185540ebb7d26c5403ca52a50de6cf161c79cb93ccd47ff1b43b87415fe1c",
  ],
  [
    "0014_message_part_sequence",
    "66b45c45e4d3a1a60829f193f38d865dcdbd3de2eb78aa79ba954fe7ef1aab08",
  ],
  [
    "0015_message_part_sequence_backfill_and_guard",
    "da3046bf061ebb5ba253bb772f0fc9e4d1f2856dac4cdbc4cc0a65aae00e8511",
  ],
  ["0016_session_input_ledger", "18d51ae3f5e1425dc1e5c809282129fdc7430cacb6b1ce517b412ddbc34be790"],
  [
    "0017_session_input_start_now_delivery",
    "8c2da5985ecdf342438a2df713c9e18114276a0e85ce6f2e4f79bdf1596b52f8",
  ],
  [
    "0018_session_input_failed_status",
    "a4d1a7b7c5d4af426b695769ed0f3a031efac8aa7af1f6412a85292c42b5d15b",
  ],
  ["0019_dwf_journal", "1c8da5568d2357f25c392be486fae80e1f3ad3ebc830dab1bee941634573e8ba"],
  [
    "0020_provider_model_selection",
    "681180b4fcb497e13289b6970021678f24c975efdf3538777541105c5b2b444e",
  ],
  [
    "0021_official_glm_selection",
    "433a8da454682406e962b043f2e0f412e9801bf7e4641ff25760aa16625ebafe",
  ],
  [
    "0022_backfilled_session_reasoning",
    "aee472fe499e9c25d2e71df0fbc68d92e462b30d1d02919ca35d540bf133c99a",
  ],
  [
    "0023_repair_invalid_model_selection",
    "4c6e691908fc69c6e4397e37723a54f0788117067a0b90eb671f468c14dda264",
  ],
  [
    "0023_session_soft_delete_outcome",
    "999cc9840e30c94f8a6628440f3e729c24e7ee839720f3e76099b3c3127a8bd8",
  ],
  [
    "0024_session_database_identity",
    "3eb41922313d66d492544ac05e0b314d55cdccbfc49f118768c0b4b0121e18b3",
  ],
];

test("Host published JSON ledger fixture remains frozen after runner adaptation", async (t) => {
  const f = await fixture(t, "host-ledger.sqlite");
  await host.runTasksDatabaseMigrationsAsync(f.db, { backupDirectories: f.backupDirectories });
  assert.deepEqual(
    f.db
      .prepare("SELECT id,checksum FROM tasks_schema_migration ORDER BY id")
      .all()
      .map((row) => [row.id, row.checksum]),
    hostLedger,
  );
  await host.runTasksDatabaseMigrations(f.db);
});

test("CLI published SQL trim checksums and ledger identifiers are frozen before adaptation", () => {
  assert.deepEqual(
    SQLITE_MIGRATIONS.map((step) => [
      step.id,
      createHash("sha256").update(step.sql.trim()).digest("hex"),
    ]),
    cliChecksums,
  );
});

async function fixture(t, name) {
  const root = await createProjectTestFixture("sqlite-startup");
  const path = join(root, name);
  const db = new DatabaseSync(path);
  const connections = [db];
  const connect = () => {
    const connection = new DatabaseSync(path);
    connections.push(connection);
    return connection;
  };
  t.after(async () => {
    for (const connection of connections.toReversed()) if (connection.isOpen) connection.close();
  });
  return { root, path, db, connect, backupDirectories: [join(root, "backup")] };
}

test("Host ready inspection is read-only and both migration names use one asynchronous owner", async (t) => {
  const f = await fixture(t, "tasks.sqlite");
  // 当前两个名称是同一个异步入口；只读预检才是 Repo 的 admission 合同。
  assert.equal(host.runTasksDatabaseMigrations, host.runTasksDatabaseMigrationsAsync);
  assert.equal(host.areTasksDatabaseMigrationsApplied(f.db), false);
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='table'").get().n,
    0,
  );
});

test("CLI sync constructor entry validates ready only and never runs DDL or migration", async (t) => {
  const f = await fixture(t, "sessions.sqlite");
  assert.throws(() => cli.runSqliteSessionMigrations(f.db, f.path));
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='table'").get().n,
    0,
  );
});

test("CLI startup backs up existing rows before applying next frozen SQL migration", async (t) => {
  const f = await fixture(t, "sessions.sqlite");
  await migrate(
    f.db,
    SQLITE_MIGRATIONS.slice(0, 1).map((step) => ({
      ...step,
      touchedTables: [
        "session",
        "message",
        "part",
        "todo",
        "session_entry",
        "permission",
        "input_history",
      ],
    })),
    { database: "cli", backupDirectories: f.backupDirectories },
  );
  f.db.exec(
    "INSERT INTO permission VALUES('fixture',1,1,'[]'); INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES('fixture-session','fixture','fixture','/fixture','Fixture','1',1,1)",
  );
  const blocked = join(f.root, "blocked");
  await writeFile(blocked, "not a directory");
  const progress = [];
  await assert.rejects(
    cli.runSqliteSessionMigrationsAsync(f.db, f.path, {
      backupDirectories: [blocked],
      onProgress: async (event) => progress.push(event),
    }),
  );
  assert.equal(progress.at(-1).phase, "failed");
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM schema_migration").get().n, 1);
  assert.equal(f.db.prepare("SELECT data FROM permission").get().data, "[]");
  assert.equal(
    f.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='local_setting'").get(),
    undefined,
  );
  await cli.runSqliteSessionMigrationsAsync(f.db, f.path, {
    backupDirectories: f.backupDirectories,
  });
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM schema_migration").get().n,
    cliChecksums.length,
  );
  assert.equal((await readdir(f.backupDirectories[0])).length, 1);
  cli.runSqliteSessionMigrations(f.db, f.path);
});

test("Host historical JSON ledger upgrades once, blocks backup faults and restores original ledger", async (t) => {
  const f = await fixture(t, "host-history.sqlite");
  await migrate(f.db, host.TASKS_DATABASE_MIGRATIONS.slice(0, 1), {
    database: "tasks_schema",
    journalTable: "tasks_schema_migration",
    backupDirectories: f.backupDirectories,
  });
  f.db.exec(
    "INSERT INTO automations(automation_id,cron_expr,prompt,model,provider,workspace_key,workspace_path,created_at,updated_at) VALUES('fixture','0 * * * *','Fixture','custom:fixture:model','fixture','/fixture','/fixture',1,1)",
  );
  const before = f.db.prepare("SELECT * FROM automations").all();
  const blocked = join(f.root, "blocked");
  await writeFile(blocked, "not a directory");
  await assert.rejects(
    host.runTasksDatabaseMigrationsAsync(f.db, { backupDirectories: [blocked] }),
    (error) => error.kind === "backup_failed",
  );
  assert.deepEqual(f.db.prepare("SELECT * FROM automations").all(), before);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM tasks_schema_migration").get().n, 1);
  const result = await host.runTasksDatabaseMigrationsAsync(f.db, {
    backupDirectories: f.backupDirectories,
  });
  assert.deepEqual(
    result.applied,
    hostLedger.slice(1).map(([id]) => id),
  );
  assert.deepEqual(
    (await host.runTasksDatabaseMigrationsAsync(f.db, { backupDirectories: f.backupDirectories }))
      .applied,
    [],
  );
  // 当前追加的执行归属列改变 schema，通用恢复不得假装能回退 DDL。
  const upgraded = f.db.prepare("SELECT * FROM automations").all();
  await assert.rejects(
    restore(f.db, result.backupPath, { database: "tasks_schema", writersStopped: true }),
    /changed database schema/,
  );
  assert.deepEqual(f.db.prepare("SELECT * FROM automations").all(), upgraded);

  // 原先数据型迁移的可恢复合同仍保留，使用真实历史前三步，而非当前新增 DDL。
  const historical = await fixture(t, "host-restore-history.sqlite");
  const historicalOptions = {
    database: "tasks_schema",
    journalTable: "tasks_schema_migration",
    backupDirectories: historical.backupDirectories,
  };
  await migrate(historical.db, host.TASKS_DATABASE_MIGRATIONS.slice(0, 1), historicalOptions);
  historical.db.exec(
    "INSERT INTO automations(automation_id,cron_expr,prompt,model,provider,workspace_key,workspace_path,created_at,updated_at) VALUES('fixture','0 * * * *','Fixture','custom:fixture:model','fixture','/fixture','/fixture',1,1)",
  );
  const historicalRows = historical.db.prepare("SELECT * FROM automations").all();
  const historicalUpgrade = await migrate(
    historical.db,
    host.TASKS_DATABASE_MIGRATIONS.slice(0, 3),
    historicalOptions,
  );
  await restore(historical.db, historicalUpgrade.backupPath, {
    database: "tasks_schema",
    writersStopped: true,
  });
  assert.deepEqual(historical.db.prepare("SELECT * FROM automations").all(), historicalRows);
  assert.deepEqual(
    historical.db
      .prepare("SELECT id,checksum FROM tasks_schema_migration ORDER BY id")
      .all()
      .map((row) => [row.id, row.checksum]),
    hostLedger.slice(0, 1),
  );
});

test("Host startup owns migration and reports ready only after original maintenance", async (t) => {
  const f = await fixture(t, "host-startup.sqlite");
  const phases = [];
  await prepareTasksIndexStorage(f.path, (phase, facts) => phases.push({ phase, facts }), {
    backupDirectories: f.backupDirectories,
  });
  assert.equal(phases.at(-1).phase, "ready");
  assert.ok(
    phases.findIndex((event) => event.phase === "committing") <
      phases.findIndex((event) => event.phase === "maintaining"),
  );
  assert.equal(phases.at(-1).facts.committedCount, hostLedger.length);
  assert.equal(host.areTasksDatabaseMigrationsApplied(f.db), true);
  const repeated = [];
  await prepareTasksIndexStorage(f.path, (phase, facts) => repeated.push({ phase, facts }), {
    backupDirectories: f.backupDirectories,
  });
  assert.equal(repeated.at(-1).facts.executedCount, 0);
  assert.equal(repeated.at(-1).facts.committedCount, 0);
});

test("Host startup backup failure never publishes migrated, maintaining or ready", async (t) => {
  const f = await fixture(t, "host-failed.sqlite");
  await migrate(f.db, host.TASKS_DATABASE_MIGRATIONS.slice(0, 1), {
    database: "tasks_schema",
    journalTable: "tasks_schema_migration",
    backupDirectories: f.backupDirectories,
  });
  f.db.exec(
    "INSERT INTO automations(automation_id,cron_expr,prompt,workspace_key,workspace_path,created_at,updated_at) VALUES('fixture','0 * * * *','Fixture','/fixture','/fixture',1,1)",
  );
  const before = f.db.prepare("SELECT * FROM automations").all();
  const blocked = join(f.root, "blocked");
  await writeFile(blocked, "not a directory");
  const phases = [];
  await assert.rejects(
    prepareTasksIndexStorage(f.path, (phase) => phases.push(phase), {
      backupDirectories: [blocked],
    }),
  );
  assert.equal(
    phases.some((phase) => ["migrating", "maintaining", "committing", "ready"].includes(phase)),
    false,
  );
  assert.deepEqual(f.db.prepare("SELECT * FROM automations").all(), before);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM tasks_schema_migration").get().n, 1);
});

test("CLI two startup connections serialize during asynchronous progress and re-read ledger", async (t) => {
  const f = await fixture(t, "two-cli.sqlite");
  const second = f.connect();
  let entered;
  let release;
  const reached = new Promise((resolve) => {
    entered = resolve;
  });
  const firstEvents = [];
  const secondEvents = [];
  let paused = false;
  const first = cli.runSqliteSessionMigrationsAsync(f.db, f.path, {
    backupDirectories: f.backupDirectories,
    onProgress: async (event) => {
      firstEvents.push(event);
      if (event.phase === "migrating" && !paused) {
        paused = true;
        entered();
        await new Promise((resolve) => {
          release = resolve;
        });
      }
    },
  });
  await reached;
  const next = cli.runSqliteSessionMigrationsAsync(second, f.path, {
    backupDirectories: f.backupDirectories,
    onProgress: async (event) => secondEvents.push(event),
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  release();
  await Promise.all([first, next]);
  assert.equal(firstEvents.at(-1).migration.committedCount, cliChecksums.length);
  assert.equal(secondEvents.at(-1).migration.executedCount, 0);
  assert.equal(secondEvents.at(-1).migration.committedCount, 0);
  assert.equal(secondEvents.at(-1).phase, "ready");
});

test("CLI failed progress transport rolls back runner-owned SQL before reporting failure", async (t) => {
  const f = await fixture(t, "cli-progress-failed.sqlite");
  const phases = [];
  await assert.rejects(
    cli.runSqliteSessionMigrationsAsync(f.db, f.path, {
      backupDirectories: f.backupDirectories,
      onProgress: async (event) => {
        phases.push(event.phase);
        if (event.phase === "committing") throw new Error("fixture progress failure");
      },
    }),
  );
  assert.equal(phases.at(-1), "failed");
  assert.equal(phases.includes("ready"), false);
  assert.equal(f.db.isTransaction, false);
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='table'").get().n,
    0,
  );
});

test("ready checks reject unknown ledger entries and missing table structure without repair", async (t) => {
  const f = await fixture(t, "host-corrupt.sqlite");
  await host.runTasksDatabaseMigrationsAsync(f.db, { backupDirectories: f.backupDirectories });
  f.db
    .prepare("INSERT INTO tasks_schema_migration VALUES(?,?,?)")
    .run("9999_future", "0".repeat(64), 1);
  assert.throws(() => host.areTasksDatabaseMigrationsApplied(f.db));
  f.db.exec(
    "DELETE FROM tasks_schema_migration WHERE id='9999_future'; DROP TABLE automation_runs",
  );
  assert.throws(() => host.areTasksDatabaseMigrationsApplied(f.db));
  assert.equal(
    f.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='automation_runs'").get(),
    undefined,
  );
});

test("current Host and CLI schema snapshots derive only from frozen migration contracts", async (t) => {
  const f = await fixture(t, "current-schema.sqlite");
  await host.runTasksDatabaseMigrationsAsync(f.db, { backupDirectories: f.backupDirectories });
  const hostSchema = dumpSqliteSchema(f.db);
  assertAdditiveSchema(hostSchema, hostSchema);
  const cliDb = new DatabaseSync(":memory:");
  try {
    await migrate(cliDb, SESSION_DATABASE_MIGRATIONS, {
      database: "cli",
      backupDirectories: f.backupDirectories,
    });
    const schema = dumpSqliteSchema(cliDb);
    assertAdditiveSchema(schema, schema);
    assert.equal(
      cliDb.prepare("SELECT count(*) AS n FROM schema_migration").get().n,
      cliChecksums.length,
    );
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM tasks_schema_migration").get().n,
      hostLedger.length,
    );
    assert.equal(
      f.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='zcode_database_identity'").get(),
      undefined,
    );
    // 当前 CLI 接管身份表结构但不擅自生成身份；Host 仍使用自己的数据库合同。
    assert.equal(cliDb.prepare("SELECT count(*) AS n FROM zcode_database_identity").get().n, 0);
  } finally {
    cliDb.close();
  }
});

test("CLI old permission conversion requires a backup even when the destination table is empty", async (t) => {
  const f = await fixture(t, "permission-conversion.sqlite");
  await migrate(f.db, SESSION_DATABASE_MIGRATIONS.slice(0, 2), {
    database: "cli",
    backupDirectories: f.backupDirectories,
  });
  f.db.exec("INSERT INTO permission VALUES('fixture',1,1,'[]')");
  const blocked = join(f.root, "blocked-permission");
  await writeFile(blocked, "not a directory");
  await assert.rejects(
    cli.runSqliteSessionMigrationsAsync(f.db, f.path, { backupDirectories: [blocked] }),
    (error) => error.cause?.kind === "backup_failed",
  );
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM schema_migration").get().n, 2);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM local_setting").get().n, 0);
  assert.equal(f.db.prepare("SELECT data FROM permission").get().data, "[]");
});

test("CLI openStartup is the real asynchronous owner and sync constructor only admits its ready ledger", async (t) => {
  const f = await fixture(t, "open-startup.sqlite");
  const dbPath = join(f.root, "nested", "sessions.sqlite");
  const phases = [];
  const store = await SqliteSessionStore.openStartup(
    { dbPath },
    {
      backupDirectories: f.backupDirectories,
      onProgress: (event) => phases.push(event),
    },
  );
  try {
    assert.equal(phases.at(-1).phase, "ready");
    assert.equal(phases.at(-1).migration.committedCount, cliChecksums.length);
    // constructor 已私有化，重开也必须经过当前唯一异步入口，不能调用旧构造签名。
    const repeated = [];
    const ready = await SqliteSessionStore.openStartup(
      { dbPath },
      {
        backupDirectories: f.backupDirectories,
        onProgress: (event) => repeated.push(event),
      },
    );
    assert.equal(repeated.at(-1).migration.executedCount, 0);
    ready.close();
  } finally {
    store.close();
  }
});

test("pre-cancelled CLI openStartup creates no directory and opens no database", async (t) => {
  const f = await fixture(t, "cancel-open.sqlite");
  const signal = new AbortController();
  const reason = new Error("fixture cancelled before startup");
  signal.abort(reason);
  await assert.rejects(
    SqliteSessionStore.openStartup(
      { dbPath: join(f.root, "cancelled", "sessions.sqlite") },
      {
        backupDirectories: f.backupDirectories,
        signal: signal.signal,
      },
    ),
  );
  assert.equal((await readdir(f.root)).includes("cancelled"), false);
});

test("Host cancellation at maintenance admission preserves committed facts but never publishes ready", async (t) => {
  const f = await fixture(t, "cancel-after-commit.sqlite");
  const signal = new AbortController();
  const reason = new Error("fixture cancelled at maintenance admission");
  const phases = [];
  await assert.rejects(
    prepareTasksIndexStorage(
      f.path,
      (phase, facts) => {
        phases.push({ phase, facts });
        if (phase === "maintaining") signal.abort(reason);
      },
      { backupDirectories: f.backupDirectories, signal: signal.signal },
    ),
    (error) => error === reason,
  );
  assert.equal(
    phases.some((event) => event.phase === "ready"),
    false,
  );
  assert.equal(phases.at(-1).facts.committedCount, hostLedger.length);
  assert.equal(host.areTasksDatabaseMigrationsApplied(f.db), true);
});

test("Host cancellation during lock-held startup rolls back and leaves no ready schema", async (t) => {
  const f = await fixture(t, "cancel-host-startup.sqlite");
  const signal = new AbortController();
  const reason = new Error("fixture cancelled before commit");
  const phases = [];
  await assert.rejects(
    prepareTasksIndexStorage(
      f.path,
      (phase) => {
        phases.push(phase);
        if (phase === "migrating") signal.abort(reason);
      },
      { backupDirectories: f.backupDirectories, signal: signal.signal },
    ),
    (error) => error === reason,
  );
  assert.equal(
    phases.some((phase) => ["maintaining", "ready"].includes(phase)),
    false,
  );
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='table'").get().n,
    0,
  );
});

test("CLI cancellation before commit closes its unpublished store without ready or ledger", async (t) => {
  const f = await fixture(t, "cancel-cli-startup.sqlite");
  const signal = new AbortController();
  const reason = new Error("fixture cancelled CLI migration");
  const phases = [];
  await assert.rejects(
    SqliteSessionStore.openStartup(
      { dbPath: f.path },
      {
        backupDirectories: f.backupDirectories,
        signal: signal.signal,
        onProgress: (event) => {
          phases.push(event.phase);
          if (event.phase === "migrating") signal.abort(reason);
        },
      },
    ),
    (error) => error.cause === reason,
  );
  assert.equal(phases.at(-1), "failed");
  assert.equal(phases.includes("ready"), false);
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='table'").get().n,
    0,
  );
});

for (const [name, adapter, ready, sql] of [
  [
    "Host",
    (f) => host.runTasksDatabaseMigrationsAsync(f.db, { backupDirectories: f.backupDirectories }),
    (f) => host.areTasksDatabaseMigrationsApplied(f.db),
    "ALTER TABLE tasks DROP COLUMN task_status",
  ],
  [
    "CLI",
    (f) =>
      cli.runSqliteSessionMigrationsAsync(f.db, f.path, { backupDirectories: f.backupDirectories }),
    (f) => cli.runSqliteSessionMigrations(f.db, f.path),
    "ALTER TABLE session DROP COLUMN slug",
  ],
])
  test(`${name} ready schema checks reject missing business columns without repairing them`, async (t) => {
    const f = await fixture(t, `${name.toLowerCase()}-missing-column.sqlite`);
    await adapter(f);
    f.db.exec(sql);
    assert.throws(() => ready(f));
    await assert.rejects(
      adapter(f),
      (error) => (error.cause?.kind ?? error.kind) === "schema_incompatible",
    );
  });
