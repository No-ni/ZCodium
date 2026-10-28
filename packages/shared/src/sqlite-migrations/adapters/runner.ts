import type { DatabaseSync } from "node:sqlite";
import type { MigrationOptions, MigrationResult, SqliteMigration } from "../contract.js";
import { createMigrationBackup } from "./backup.js";
import {
  acquireMigrationLock,
  assertMainDatabaseScope,
  withMigrationAdmission,
  withShortBusyTimeout,
} from "./coordination.js";
import {
  createMigrationJournal,
  inspectMigrations,
  journalSettings,
  migrationChecksum,
  validateMigrations,
} from "./ledger.js";
import { identifier } from "./table-snapshot.js";

export async function migrate(
  db: DatabaseSync,
  migrations: readonly SqliteMigration[],
  options: MigrationOptions,
): Promise<MigrationResult> {
  validateMigrations(migrations);
  journalSettings(options);
  assertMainDatabaseScope(db);
  if (
    typeof options.database !== "string" ||
    !options.database.trim() ||
    !Array.isArray(options.backupDirectories)
  )
    throw new Error("Migration requires database identity and explicit backup directories");
  return withMigrationAdmission(db, () => migrateExclusive(db, migrations, options), options);
}

async function migrateExclusive(
  db: DatabaseSync,
  migrations: readonly SqliteMigration[],
  options: MigrationOptions,
): Promise<MigrationResult> {
  // 错配时事务尚未移交，不能用 finally/catch 回滚调用方自己的写入。
  if (db.isTransaction !== Boolean(options.transactionOpen))
    throw new Error("Migration transaction ownership mismatch");
  assertMainDatabaseScope(db);
  return withShortBusyTimeout(db, async () => {
    let transactionOwned = Boolean(options.transactionOpen);
    let currentMigrationId: string | undefined;
    try {
      if (!transactionOwned) {
        await acquireMigrationLock(db, options);
        transactionOwned = true;
      }
      // 只读预检不授权写入；admission 和跨进程等待后必须锁内重读真实账本。
      assertMainDatabaseScope(db);
      const inspection = inspectMigrations(db, migrations, options);
      await options.onLocked?.(inspection);
      options.signal?.throwIfAborted();
      assertMainDatabaseScope(db);
      const pending = migrations.filter((step) => inspection.pending.includes(step.id));
      // CREATE journal 与别名补写也属于迁移写入，备份完成前不触碰任何持久化状态。
      const backupPath = pending.length
        ? await createMigrationBackup(db, pending, options)
        : undefined;
      options.signal?.throwIfAborted();
      assertMainDatabaseScope(db);
      createMigrationJournal(db, options);
      const { name, appliedAt, taskJournal } = journalSettings(options);
      for (const step of pending) {
        currentMigrationId = step.id;
        options.signal?.throwIfAborted();
        await options.onBeforeApply?.(step.id);
        options.signal?.throwIfAborted();
        assertMainDatabaseScope(db);
        if (step.apply) step.apply(db);
        else db.exec(step.sql);
        assertMainDatabaseScope(db);
        if (!db.isTransaction) throw new Error("Migration apply cannot own the runner transaction");
        const appliedAtMs = (options.now ?? Date.now)();
        if (!Number.isSafeInteger(appliedAtMs))
          throw new Error("Migration applied-at must be a safe integer");
        db.prepare(
          `INSERT INTO ${identifier(name)}(id,checksum,${taskJournal ? "" : "app_version,"}${identifier(appliedAt)}) VALUES (?,?${taskJournal ? "" : ",?"},?)`,
        ).run(
          step.id,
          migrationChecksum(step),
          ...(taskJournal ? [] : [step.appVersion]),
          appliedAtMs,
        );
        options.onApplied?.(step.id);
      }
      await options.onCommitting?.();
      options.signal?.throwIfAborted();
      assertMainDatabaseScope(db);
      db.exec("COMMIT");
      transactionOwned = false;
      return {
        applied: pending.map((step) => step.id),
        ...(backupPath ? { backupPath } : {}),
        backupSkipped: false,
      };
    } catch (error) {
      try {
        if (transactionOwned && db.isTransaction) db.exec("ROLLBACK");
      } catch {
        /* 调用方关闭连接，保留迁移首因。 */
      }
      if (error && typeof error === "object" && currentMigrationId) {
        try {
          Object.assign(error, { migrationId: currentMigrationId });
        } catch {
          /* 不可扩展异常仍保留首因。 */
        }
      }
      throw error;
    }
  });
}
