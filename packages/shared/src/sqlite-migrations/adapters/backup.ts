import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, rename } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  MigrationBackupError,
  migrationBackupSchema,
  type MigrationBackup,
  type MigrationOptions,
  type SqliteMigration,
} from "../contract.js";
import { databasePathHash } from "./coordination.js";
import { journalSettings, migrationChecksum } from "./ledger.js";
import {
  identifier,
  describeTable,
  schemaHash,
  schemaObjects,
  snapshotTable,
  type TableLayout,
} from "./table-snapshot.js";

export const BACKUP_DATABASE_FILE = "tables.sqlite";
export const BACKUP_METADATA_TABLE = "_zcodium_migration_backup";

export async function createMigrationBackup(
  db: DatabaseSync,
  pending: readonly SqliteMigration[],
  options: MigrationOptions,
): Promise<string | undefined> {
  let failure: unknown;
  try {
    const tables: TableLayout[] = [];
    const names = new Set(
      pending.flatMap((step) => step.touchedTables.map((table) => table.toLowerCase())),
    );
    for (const name of names) {
      options.signal?.throwIfAborted();
      const table = describeTable(db, name);
      if (table) tables.push(table);
    }
    if (
      !tables.some((table) => db.prepare(`SELECT 1 FROM ${identifier(table.name)} LIMIT 1`).get())
    )
      return undefined;
    const { name: journalTable, appliedAt: appliedAtColumn } = journalSettings(options);
    const journal = describeTable(db, journalTable);
    if (journal) tables.push(journal);
    const objects = schemaObjects(db);
    const metadataBase = {
      version: 2,
      owner: "zcodium-sqlite-migrations",
      database: options.database,
      databasePathHash: await databasePathHash(db),
      journalTable,
      journalExisted: Boolean(journal),
      appliedAtColumn,
      migrations: pending.map((step) => step.id),
      migrationContracts: pending.map((step) => ({
        id: step.id,
        checksum: migrationChecksum(step),
        appVersion: step.appVersion,
      })),
      schemaObjects: objects,
      schemaHash: schemaHash(objects),
    } satisfies Omit<MigrationBackup, "tables">;
    for (const directory of options.backupDirectories) {
      if (!isAbsolute(directory)) throw new MigrationBackupError();
      try {
        options.signal?.throwIfAborted();
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const path = join(directory, `zcodium-${Date.now()}-${randomUUID()}`);
        await mkdir(path, { mode: 0o700 });
        const backupFile = join(path, BACKUP_DATABASE_FILE);
        const reserved = await open(backupFile, "wx", 0o600);
        await reserved.close();
        const backup = new DatabaseSync(backupFile);
        let encoded: string;
        try {
          backup.exec("PRAGMA cache_size=-2048; BEGIN");
          const snapshots: MigrationBackup["tables"] = [];
          for (const table of tables) {
            backup.exec(
              `CREATE TABLE ${identifier(table.name)} (${table.columns.map(identifier).join(",")})`,
            );
            // 备份前不再持有正文快照；锁内逐行复制与计算摘要，副本独立逐行复验。
            const snapshot = await snapshotTable(db, table.name, table, options.signal, {
              version: 2,
              target: backup,
            });
            const written = await snapshotTable(backup, table.name, table, options.signal);
            if (!snapshot || written?.hash !== snapshot.hash || written.rows !== snapshot.rows)
              throw new MigrationBackupError();
            snapshots.push(snapshot);
          }
          encoded = JSON.stringify(
            migrationBackupSchema.parse({ ...metadataBase, tables: snapshots }),
          );
          // 根因：仅校验外部 JSON 的 hash 无法识别清单删减/改写；副本保存完整可信清单用于交叉验收。
          backup.exec(
            `CREATE TABLE ${identifier(BACKUP_METADATA_TABLE)} (id INTEGER PRIMARY KEY CHECK(id=1), metadata TEXT NOT NULL)`,
          );
          backup
            .prepare(`INSERT INTO ${identifier(BACKUP_METADATA_TABLE)} VALUES(1,?)`)
            .run(encoded);
          backup.exec("COMMIT");
          if (
            backup
              .prepare("PRAGMA quick_check")
              .all()
              .some((row) => row.quick_check !== "ok")
          )
            throw new MigrationBackupError();
          const saved = backup
            .prepare(`SELECT metadata FROM ${identifier(BACKUP_METADATA_TABLE)} WHERE id=1`)
            .get();
          if (saved?.metadata !== encoded) throw new MigrationBackupError();
        } finally {
          backup.close();
        }
        await chmod(backupFile, 0o600);
        const file = await open(backupFile, "r+");
        try {
          await file.sync();
        } finally {
          await file.close();
        }
        options.signal?.throwIfAborted();
        const temporaryMetadata = join(path, "backup.json.tmp");
        const metadataFile = await open(temporaryMetadata, "wx", 0o600);
        try {
          await metadataFile.writeFile(encoded);
          await metadataFile.sync();
        } finally {
          await metadataFile.close();
        }
        options.signal?.throwIfAborted();
        await rename(temporaryMetadata, join(path, "backup.json"));
        return path;
      } catch (error) {
        options.signal?.throwIfAborted();
        failure = error;
        const code = (error as NodeJS.ErrnoException).code;
        if (!["ENOSPC", "EDQUOT", "EACCES", "EPERM", "EROFS", "ENOTDIR"].includes(code ?? ""))
          break;
      }
    }
  } catch (error) {
    options.signal?.throwIfAborted();
    failure = error;
  }
  // 有旧行时任何备份失败都阻断；只尝试明确目录，不探测其它卷，不清理已完成恢复材料。
  throw new MigrationBackupError({ cause: failure });
}
