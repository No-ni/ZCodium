import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrationBackupSchema, type MigrationBackup, type RestoreOptions } from "../contract.js";
import { BACKUP_DATABASE_FILE, BACKUP_METADATA_TABLE } from "./backup.js";
import {
  acquireMigrationLock,
  assertMainDatabaseScope,
  databasePathHash,
  withForeignKeysDisabled,
  withMigrationAdmission,
  withShortBusyTimeout,
} from "./coordination.js";
import { assertMigrationJournalSchema } from "./ledger.js";
import {
  contentHash,
  identifier,
  insertSnapshot,
  schemaHash,
  schemaObjects,
  snapshotTable,
  type TableSnapshot,
} from "./table-snapshot.js";

export async function restore(
  db: DatabaseSync,
  path: string,
  options: RestoreOptions,
): Promise<void> {
  if (options.writersStopped !== true || db.isTransaction)
    throw new Error("Restore requires stopped writers and an idle connection");
  assertMainDatabaseScope(db);
  return withMigrationAdmission(db, () => restoreExclusive(db, path, options), options);
}

async function restoreExclusive(
  db: DatabaseSync,
  path: string,
  options: RestoreOptions,
): Promise<void> {
  if (db.isTransaction) throw new Error("Restore requires an idle connection");
  assertMainDatabaseScope(db);
  options.signal?.throwIfAborted();
  const encoded = await readFile(join(path, "backup.json"), {
    encoding: "utf8",
    signal: options.signal,
  });
  const metadata = migrationBackupSchema.parse(JSON.parse(encoded));
  if (
    metadata.database !== options.database ||
    metadata.databasePathHash !== (await databasePathHash(db))
  )
    throw new Error("Backup database identity mismatch");
  if (metadata.schemaHash !== schemaHash(metadata.schemaObjects))
    throw new Error("Backup schema hash mismatch");
  const backup = new DatabaseSync(join(path, BACKUP_DATABASE_FILE), { readOnly: true });
  try {
    const embedded = backup
      .prepare(`SELECT metadata FROM ${identifier(BACKUP_METADATA_TABLE)} WHERE id=1`)
      .get();
    if (embedded?.metadata !== encoded) throw new Error("Backup metadata manifest mismatch");
    const tableNames = backup
      .prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
      .all()
      .map((row) => String(row.name));
    if (
      JSON.stringify(tableNames) !==
      JSON.stringify([...metadata.tables.map((table) => table.name), BACKUP_METADATA_TABLE].sort())
    )
      throw new Error("Backup table manifest mismatch");
    if (
      backup
        .prepare("PRAGMA quick_check")
        .all()
        .some((row) => row.quick_check !== "ok")
    )
      throw new Error("Backup database check failed");
    const tables: TableSnapshot[] = [];
    for (const table of metadata.tables) {
      options.signal?.throwIfAborted();
      const info = backup.prepare(`PRAGMA table_xinfo(${identifier(table.name)})`).all();
      if (JSON.stringify(info.map((column) => column.name)) !== JSON.stringify(table.columns))
        throw new Error("Backup columns mismatch");
      const snapshot = await snapshotTable(backup, table.name, table, options.signal);
      if (!snapshot || snapshot.hash !== table.hash || snapshot.rows !== table.rows)
        throw new Error("Backup row hash mismatch");
      const originalSchema = metadata.schemaObjects.find(
        (object) => object.type === "table" && object.name === table.name,
      );
      if (originalSchema?.sql !== table.schema) throw new Error("Backup table schema mismatch");
      tables.push({ ...snapshot, schema: table.schema });
    }
    await withShortBusyTimeout(db, () =>
      withForeignKeysDisabled(db, async () => {
        let transactionOwned = false;
        try {
          await acquireMigrationLock(db, options);
          transactionOwned = true;
          options.signal?.throwIfAborted();
          assertMainDatabaseScope(db);
          if (metadata.databasePathHash !== (await databasePathHash(db)))
            throw new Error("Backup database identity mismatch");
          validateCurrentSchema(db, metadata);
          await validateCurrentLedger(db, metadata, tables, options.signal);
          options.signal?.throwIfAborted();
          // 父表删除不能级联丢失未触及的子表；全部写者停用后在同一事务内恢复并检查全库外键。
          for (const table of tables) db.exec(`DELETE FROM ${identifier(table.name)}`);
          for (const table of tables) {
            options.signal?.throwIfAborted();
            await insertSnapshot(db, table, false, options.signal);
          }
          if (!metadata.journalExisted) db.exec(`DROP TABLE ${identifier(metadata.journalTable)}`);
          if (db.prepare("PRAGMA foreign_key_check").all().length)
            throw new Error("Restore foreign key check failed");
          for (const table of tables) {
            const restored = await snapshotTable(db, table.name, table, options.signal);
            if (restored?.hash !== table.hash || restored.rows !== table.rows)
              throw new Error("Restored row hash mismatch");
          }
          options.signal?.throwIfAborted();
          db.exec("COMMIT");
          transactionOwned = false;
        } catch (error) {
          try {
            if (transactionOwned && db.isTransaction) db.exec("ROLLBACK");
          } catch {
            /* 保留首因，连接由调用者关闭。 */
          }
          throw error;
        }
      }),
    );
  } finally {
    backup.close();
  }
}

function validateCurrentSchema(db: DatabaseSync, metadata: MigrationBackup): void {
  if (
    !assertMigrationJournalSchema(db, {
      journalTable: metadata.journalTable,
      appliedAtColumn: metadata.appliedAtColumn,
    })
  )
    throw new Error("Restore migration ledger is missing");
  const current = schemaObjects(db);
  // 原无账本仅允许 runner 新建表和原生主键 autoindex；不能把后来加的 trigger/index 一起过滤掉。
  const generatedLedgerObject = (object: (typeof current)[number]) =>
    object.table === metadata.journalTable &&
    ((object.type === "table" && object.name === metadata.journalTable) ||
      (object.type === "index" &&
        object.name === `sqlite_autoindex_${metadata.journalTable}_1` &&
        object.sql === null));
  const filtered = metadata.journalExisted
    ? current
    : current.filter((object) => !generatedLedgerObject(object));
  if (schemaHash(filtered) !== metadata.schemaHash)
    throw new Error("Backup cannot restore changed database schema");
}

async function validateCurrentLedger(
  db: DatabaseSync,
  metadata: MigrationBackup,
  tables: readonly TableSnapshot[],
  signal?: AbortSignal,
): Promise<void> {
  const journal = await snapshotTable(db, metadata.journalTable, undefined, signal);
  if (!journal) throw new Error("Restore migration ledger is missing");
  const original = tables.find((table) => table.name === metadata.journalTable);
  const idPosition = journal.columns.indexOf("id");
  const checksumPosition = journal.columns.indexOf("checksum");
  const versionPosition = journal.columns.indexOf("app_version");
  const appliedAtPosition = journal.columns.indexOf(metadata.appliedAtColumn);
  const originals = new Map((original?.values ?? []).map((row) => [row[idPosition], row]));
  const pending = new Map(metadata.migrationContracts.map((step) => [step.id, step]));
  const retained: TableSnapshot["values"] = [];
  const seenPending = new Set<string>();
  for (const row of journal.values) {
    const id = row[idPosition];
    if (typeof id !== "string") throw new Error("Restore migration ledger is invalid");
    if (originals.has(id)) {
      retained.push(row);
      continue;
    }
    const contract = pending.get(id);
    const appliedAt = row[appliedAtPosition];
    const validTime =
      typeof appliedAt === "bigint"
        ? appliedAt >= BigInt(Number.MIN_SAFE_INTEGER) &&
          appliedAt <= BigInt(Number.MAX_SAFE_INTEGER)
        : Number.isSafeInteger(appliedAt);
    if (
      !contract ||
      seenPending.has(id) ||
      row[checksumPosition] !== contract.checksum ||
      !validTime ||
      (versionPosition >= 0 && row[versionPosition] !== contract.appVersion)
    )
      throw new Error("Restore migration ledger changed after backup");
    seenPending.add(id);
  }
  // 恢复不能擦掉后来提交或篡改的历史账本；备份原行逐值验收，本次 pending 必须完整匹配。
  if (
    seenPending.size !== pending.size ||
    retained.length !== originals.size ||
    (original && (await contentHash(retained, signal)) !== original.hash)
  )
    throw new Error("Restore migration ledger changed after backup");
}
