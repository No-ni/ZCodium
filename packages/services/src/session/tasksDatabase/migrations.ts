import { databaseMigrationIdSchema, type DatabaseMigrationFacts } from "@zcode/shared";
import {
  inspectMigrations,
  migrate,
  type MigrationOptions,
  type MigrationResult,
  type SqliteMigration,
} from "@zcode/shared/sqlite-migrations";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { assertTasksDatabaseSchema } from "#src/session/tasksDatabase/schema-guard.js";
import {
  AUTOMATION_SCHEMA,
  OFF_PEAK_SCHEMA,
  TASK_INDEX_SCHEMA,
} from "#src/session/tasksDatabase/schema-v1.js";
import { importLegacyAutomationSelections } from "#src/session/tasksDatabase/provider-selection-v2.js";
import { OFFICIAL_GLM_SELECTION_MIGRATION_SQL } from "#src/session/tasksDatabase/official-glm-selection-v3.js";

// 冻结历史列声明，不能以实时 Repo/schema 代替，否则新版构建会改变已应用 checksum。
const columns = [
  ["tasks", "title_overridden", "INTEGER NOT NULL DEFAULT 0"],
  ["tasks", "last_unread_at", "INTEGER NOT NULL DEFAULT 0"],
  ["tasks", "searchable_text", "TEXT NOT NULL DEFAULT ''"],
  ["tasks", "cron_automation_id", "TEXT"],
  ["tasks", "off_peak_task_id", "TEXT"],
  ["automations", "target_task_id", "TEXT"],
  ["automations", "bot_delivery_target", "TEXT"],
  ["automations", "mode", "TEXT"],
  ["automations", "end_at", "INTEGER"],
  ["automations", "schedule_rule", "TEXT"],
  ["automations", "schedule_edited_by_user", "INTEGER NOT NULL DEFAULT 0"],
  ["automations", "thought_level", "TEXT"],
  ["automations", "model_selection", "TEXT"],
  ["automations", "scheduled_run_count", "INTEGER NOT NULL DEFAULT 0"],
  ["automation_runs", "model_selection", "TEXT"],
  ["off_peak_tasks", "thought_level", "TEXT"],
  ["off_peak_tasks", "model_selection", "TEXT"],
  ["off_peak_tasks", "history_deleted_at", "INTEGER"],
] as const;
const indexes = `
  CREATE INDEX IF NOT EXISTS idx_tasks_cron_automation ON tasks(cron_automation_id, updated_at DESC)
    WHERE cron_automation_id IS NOT NULL AND deleted=0;
  CREATE INDEX IF NOT EXISTS idx_tasks_off_peak_task ON tasks(off_peak_task_id, updated_at DESC)
    WHERE off_peak_task_id IS NOT NULL AND deleted=0;
  CREATE INDEX IF NOT EXISTS idx_automations_target_task ON automations(target_task_id) WHERE target_task_id IS NOT NULL;
`;
const terminalStatuses = "'completed','failed','cancelled'";
const activePredicate = `session_id IS NOT NULL AND status NOT IN (${terminalStatuses})`;
const boundIndex = `CREATE UNIQUE INDEX IF NOT EXISTS idx_off_peak_bound_active ON off_peak_tasks(workspace_key,session_id) WHERE ${activePredicate}`;

// 与 Agent 同样是库级串行事务，但不跨域依赖其具体 adapter。TS 转换使用冻结语义版本，
// 禁用 function.toString 哈希：Electron/SEA 打包会改变函数文本而非迁移语义。
const definitions = [
  {
    id: "0001_adopt_task_schema",
    checksumInput: [
      TASK_INDEX_SCHEMA,
      AUTOMATION_SCHEMA,
      OFF_PEAK_SCHEMA,
      columns,
      indexes,
      boundIndex,
      "scheduled-count-backfill-v1",
    ],
  },
  {
    id: "0002_provider_selection",
    checksumInput: ["legacy-automation-selection-v1", "no-provider-for-legacy-off-peak-v1"],
  },
  {
    id: "0003_official_glm_selection",
    checksumInput: [OFFICIAL_GLM_SELECTION_MIGRATION_SQL],
  },
] as const;

const touchedTables: Record<(typeof definitions)[number]["id"], readonly string[]> = {
  "0001_adopt_task_schema": [
    "tasks",
    "task_groups",
    "task_group_members",
    "task_group_view_node_orders",
    "task_group_workspace_bootstraps",
    "automations",
    "automation_runs",
    "off_peak_tasks",
  ],
  "0002_provider_selection": ["automations"],
  "0003_official_glm_selection": ["automations"],
};

// 只适配合同，不改变已发布 JSON/SQL/apply：前三条历史账本 checksum 和 id 原样保留。
export const TASKS_DATABASE_MIGRATIONS: readonly SqliteMigration[] = definitions.map(
  (definition) => ({
    id: definition.id,
    appVersion: "3.15.1",
    sql:
      definition.id === "0003_official_glm_selection" ? OFFICIAL_GLM_SELECTION_MIGRATION_SQL : "",
    checksum: createHash("sha256").update(JSON.stringify(definition.checksumInput)).digest("hex"),
    touchedTables: touchedTables[definition.id],
    apply:
      definition.id === "0001_adopt_task_schema"
        ? adoptSchema
        : definition.id === "0002_provider_selection"
          ? importLegacyAutomationSelections
          : undefined,
  }),
);

export interface TasksMigrationOptions {
  transactionOpen?: boolean;
  migration?: DatabaseMigrationFacts;
  backupDirectories?: readonly string[];
  signal?: AbortSignal;
  lockWaitTimeoutMs?: number;
  onWaitingForLock?: () => void | Promise<void>;
  onProgress?: (
    phase: "migrating" | "committing",
    migration: DatabaseMigrationFacts,
  ) => void | Promise<void>;
}

/** Host startup 是唯一执行入口；通用 runner 是唯一事务 owner。 */
export async function runTasksDatabaseMigrationsAsync(
  db: DatabaseSync,
  options: TasksMigrationOptions = {},
): Promise<MigrationResult> {
  const migrationFacts: DatabaseMigrationFacts = options.migration ?? {
    kind: inspectTasksMigrationKind(db),
    executedCount: 0,
    committedCount: 0,
  };
  const path = db
    .prepare("PRAGMA database_list")
    .all()
    .find((row) => row.name === "main")?.file;
  const backupDirectories =
    options.backupDirectories ??
    (typeof path === "string" && path ? [join(dirname(path), "backup")] : []);
  const runnerOptions: MigrationOptions = {
    database: "tasks-index",
    journalTable: "tasks_schema_migration",
    backupDirectories,
    transactionOpen: options.transactionOpen,
    signal: options.signal,
    lockWaitTimeoutMs: options.lockWaitTimeoutMs,
    onWaitingForLock: options.onWaitingForLock,
    onLocked: (inspection) => {
      migrationFacts.kind = inspection.kind;
      migrationFacts.lastAppliedMigrationId =
        inspection.lastAppliedMigrationId === null
          ? null
          : databaseMigrationIdSchema.parse(inspection.lastAppliedMigrationId);
    },
    onBeforeApply: () => options.onProgress?.("migrating", { ...migrationFacts }),
    onApplied: () => {
      migrationFacts.executedCount++;
    },
    onCommitting: async () => {
      assertTasksDatabaseSchema(db);
      await options.onProgress?.("committing", { ...migrationFacts });
    },
  };
  const result = await migrate(db, TASKS_DATABASE_MIGRATIONS, runnerOptions);
  migrationFacts.committedCount = migrationFacts.executedCount;
  return result;
}

/** 旧 Repo 调用只校验，不能在 ensureReady/getter 另起无备份的同步迁移。 */
export function runTasksDatabaseMigrations(db: DatabaseSync): void {
  if (!areTasksDatabaseMigrationsApplied(db))
    throw Object.assign(
      new Error("Task storage must be prepared by the asynchronous startup owner"),
      { kind: "sql_failed" },
    );
}

function adoptSchema(db: DatabaseSync): void {
  db.exec(TASK_INDEX_SCHEMA + AUTOMATION_SCHEMA + OFF_PEAK_SCHEMA);
  for (const [table, column, definition] of columns) {
    const existing = db.prepare(`PRAGMA table_info(${table})`).all();
    if (existing.some((entry) => entry.name === column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    if (table === "automations" && column === "scheduled_run_count") {
      db.exec("UPDATE automations SET scheduled_run_count=run_count");
    }
  }
  db.exec(indexes);
  // 沿用已裁决的旧重复绑定保留策略，但不再吞掉权限/语法/磁盘等真实 SQL 错误。
  const duplicate = db
    .prepare(`SELECT 1 FROM off_peak_tasks WHERE ${activePredicate}
    GROUP BY workspace_key, session_id HAVING count(*)>1 LIMIT 1`)
    .get();
  if (!duplicate) db.exec(boundIndex);
}

/** 交接只复用已完成初始化；每个新连接仍按冻结账本确认，替换/清空文件不能假 ready。 */
export function areTasksDatabaseMigrationsApplied(db: DatabaseSync): boolean {
  const inspection = inspectMigrations(db, TASKS_DATABASE_MIGRATIONS, {
    journalTable: "tasks_schema_migration",
  });
  if (inspection.pending.length) return false;
  assertTasksDatabaseSchema(db);
  return true;
}

/** 只读账本的展示预检，不授权执行；迁移 runner 拿锁后仍复查每一项。 */
export function inspectTasksMigrationKind(db: DatabaseSync): DatabaseMigrationFacts["kind"] {
  return inspectMigrations(db, TASKS_DATABASE_MIGRATIONS, {
    journalTable: "tasks_schema_migration",
  }).kind;
}
