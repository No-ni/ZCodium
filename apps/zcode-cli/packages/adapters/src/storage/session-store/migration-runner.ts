import {
  classifyDatabaseStartupError,
  databaseMigrationIdSchema,
  databaseStartupErrorDetails,
  type DatabaseMigrationFacts,
} from "@zcode/shared";
import { inspectMigrations, migrate, retrySqliteBusy, withShortBusyTimeout } from "@zcode/shared/sqlite-migrations";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { SqliteSessionMigrationError } from "./errors.js";
import { SESSION_DATABASE_MIGRATIONS } from "./migration-contract.js";
import { assertSessionDatabaseSchema } from "./migration-schema.js";

export const DEFAULT_SQLITE_STARTUP_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_SQLITE_MIGRATION_WAIT_MS = 60 * 60_000;

export type SqliteMigrationPhase =
  | "checking"
  | "waiting_for_lock"
  | "migrating"
  | "committing"
  | "ready"
  | "failed";

export interface SqliteMigrationProgress {
  phase: SqliteMigrationPhase;
  migration?: DatabaseMigrationFacts;
  elapsedMs: number;
  migrationId?: string;
  completed?: number;
  total?: number;
  errorCode?: string;
  sqliteCode?: number;
  systemCode?: string;
}

export interface AsyncSqliteMigrationOptions {
  lockWaitTimeoutMs?: number;
  backupDirectories?: readonly string[];
  signal?: AbortSignal;
  onProgress?: (progress: SqliteMigrationProgress) => void | Promise<void>;
}

/** 兼容旧 constructor 的只读 ready 检查；不能维护第二个同步 DDL/迁移 owner。 */
export function runSqliteSessionMigrations(
  db: DatabaseSync,
  dbPath: string,
  _lockTimeoutMs = DEFAULT_SQLITE_STARTUP_LOCK_TIMEOUT_MS,
): void {
  try {
    if (inspectMigrations(db, SESSION_DATABASE_MIGRATIONS).pending.length)
      throw new Error("Session storage must be prepared with SqliteSessionStore.openStartup");
    assertSessionDatabaseSchema(db);
  } catch (error) {
    throw normalizeMigrationError(error, dbPath);
  }
}

/** CLI startup 的唯一迁移调用链；SQLite/admission/backup/COMMIT 全由通用 runner 拥有。 */
export async function runSqliteSessionMigrationsAsync(
  db: DatabaseSync,
  dbPath: string,
  options: AsyncSqliteMigrationOptions = {},
): Promise<void> {
  const startedAt = Date.now();
  const deadline = startedAt + (options.lockWaitTimeoutMs ?? DEFAULT_SQLITE_MIGRATION_WAIT_MS);
  let migrationFacts: DatabaseMigrationFacts | undefined;
  const progress = (phase: SqliteMigrationPhase, details: Partial<SqliteMigrationProgress> = {}): SqliteMigrationProgress => ({
    phase, elapsedMs: Date.now() - startedAt, ...(migrationFacts ? { migration: { ...migrationFacts } } : {}), ...details,
  });
  const report = (phase: SqliteMigrationPhase, details?: Partial<SqliteMigrationProgress>) => options.onProgress?.(progress(phase, details));
  const waitOptions = () => ({
    signal: options.signal, lockWaitTimeoutMs: Math.max(0, deadline - Date.now()),
    onWaitingForLock: () => report("waiting_for_lock"),
  });
  try {
    await report("checking");
    await withShortBusyTimeout(db, async () => {
      db.exec("PRAGMA foreign_keys=ON");
      await retrySqliteBusy(() => {
        const inspection = inspectMigrations(db, SESSION_DATABASE_MIGRATIONS);
        migrationFacts = { kind: inspection.kind, executedCount: 0, committedCount: 0 };
      }, waitOptions());
      await report("checking");
      await migrate(db, SESSION_DATABASE_MIGRATIONS, {
        ...waitOptions(), database: "cli", appliedAtColumn: "time_applied",
        backupDirectories: options.backupDirectories ?? (dbPath === ":memory:" ? [] : [join(dirname(dbPath), "backup")]),
        onLocked: (inspection) => {
          migrationFacts = {
            kind: inspection.kind, executedCount: 0, committedCount: 0,
            lastAppliedMigrationId: inspection.lastAppliedMigrationId === null ? null : databaseMigrationIdSchema.parse(inspection.lastAppliedMigrationId),
          };
        },
        onBeforeApply: (id) => report("migrating", { migrationId: id, completed: SESSION_DATABASE_MIGRATIONS.findIndex((step) => step.id === id), total: SESSION_DATABASE_MIGRATIONS.length }),
        onApplied: () => { if (migrationFacts) migrationFacts.executedCount++; },
        onCommitting: async () => {
          assertSessionDatabaseSchema(db);
          await report("committing");
        },
      });
      if (migrationFacts) migrationFacts.committedCount = migrationFacts.executedCount;
      // 备份失败不能提前改持久化 journal 模式；迁移提交后才配置业务连接 WAL。
      await retrySqliteBusy(() => {
        const current = db.prepare("PRAGMA journal_mode").get()?.journal_mode;
        if (current === "wal" || current === "memory") return;
        if (db.prepare("PRAGMA journal_mode=WAL").get()?.journal_mode !== "wal")
          throw new Error("SQLite refused WAL journal mode");
      }, waitOptions());
    });
    options.signal?.throwIfAborted();
    await report("ready");
  } catch (error) {
    // 通用 runner 已回滚自己的事务；失败通知不能覆盖首因或再次持有迁移事务。
    const normalized = normalizeMigrationError(error, dbPath, databaseStartupErrorDetails(error).migrationId);
    try { await report("failed", { errorCode: normalized.kind, ...databaseStartupErrorDetails(normalized), migrationId: normalized.migrationId }); }
    catch { /* 错误通知传输失败保留原数据库异常。 */ }
    throw normalized;
  }
}

function normalizeMigrationError(error: unknown, dbPath: string, migrationId?: string): SqliteSessionMigrationError {
  if (error instanceof SqliteSessionMigrationError) return error;
  return new SqliteSessionMigrationError("SQLite session migration failed", {
    cause: error, dbPath, kind: classifyDatabaseStartupError(error), migrationId,
  });
}
