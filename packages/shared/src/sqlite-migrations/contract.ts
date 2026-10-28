import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";

export interface SqliteMigration {
  id: string;
  appVersion: string;
  sql: string;
  touchedTables: readonly string[];
  /** 已发布 JSON 账本使用冻结 hash；缺席时沿用 SQL trim SHA-256。 */
  checksum?: string;
  previousIds?: readonly string[];
  apply?: (db: DatabaseSync) => void;
}

export interface MigrationInspection {
  kind: "none" | "initialize" | "upgrade";
  pending: string[];
  lastAppliedMigrationId: string | null;
}

export interface MigrationOptions {
  database: string;
  /** 只在调用方持有 IMMEDIATE 写锁时移交；runner 成功提交或失败回滚。 */
  transactionOpen?: boolean;
  journalTable?: "schema_migration" | "tasks_schema_migration";
  appliedAtColumn?: "time_applied" | "applied_at";
  backupDirectories: readonly string[];
  onLocked?: (inspection: MigrationInspection) => void | Promise<void>;
  onBeforeApply?: (id: string) => void | Promise<void>;
  onApplied?: (id: string) => void;
  onCommitting?: () => void | Promise<void>;
  onWaitingForLock?: () => void | Promise<void>;
  lockWaitTimeoutMs?: number;
  signal?: AbortSignal;
  now?: () => number;
}

export interface RestoreOptions {
  database: string;
  /** 调用方停用所有进程的业务写者；这不是自动停写功能。 */
  writersStopped: true;
  lockWaitTimeoutMs?: number;
  onWaitingForLock?: () => void | Promise<void>;
  signal?: AbortSignal;
}

export interface MigrationResult {
  applied: string[];
  backupPath?: string;
  backupSkipped: false;
}

export class MigrationChecksumError extends Error {
  readonly kind = "checksum_mismatch";
  constructor(readonly migrationId: string) {
    super(`Migration checksum mismatch: ${migrationId}`);
    this.name = "MigrationChecksumError";
  }
}
export class MigrationBackupError extends Error {
  readonly kind = "backup_failed";
  constructor(options?: ErrorOptions) {
    super("Database backup could not be completed; migration was not applied.", options);
    this.name = "MigrationBackupError";
  }
}

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const identifierSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const migrationIdSchema = z.string().regex(/^[A-Za-z_0-9-]{1,128}$/);

export const sqliteSchemaObjectSchema = z
  .object({
    type: z.enum(["table", "index", "trigger", "view"]),
    name: z.string().min(1),
    table: z.string().min(1),
    sql: z.string().nullable(),
  })
  .strict();
export type SqliteSchemaObject = z.infer<typeof sqliteSchemaObjectSchema>;

export const migrationBackupSchema = z
  .object({
    version: z.literal(1),
    owner: z.literal("zcodium-sqlite-migrations"),
    database: z.string().min(1),
    databasePathHash: hashSchema,
    journalTable: z.enum(["schema_migration", "tasks_schema_migration"]),
    journalExisted: z.boolean(),
    appliedAtColumn: z.enum(["time_applied", "applied_at"]),
    migrations: z.array(migrationIdSchema).nonempty(),
    migrationContracts: z
      .array(
        z
          .object({
            id: migrationIdSchema,
            checksum: hashSchema,
            appVersion: z.string(),
          })
          .strict(),
      )
      .nonempty(),
    schemaObjects: z.array(sqliteSchemaObjectSchema),
    schemaHash: hashSchema,
    tables: z
      .array(
        z
          .object({
            name: identifierSchema,
            columns: z.array(identifierSchema).nonempty(),
            insertColumns: z.array(identifierSchema).nonempty(),
            rowidColumn: z.enum(["rowid", "_rowid_", "oid"]).nullable(),
            schema: z.string().min(1),
            rows: z.number().int().nonnegative(),
            hash: hashSchema,
          })
          .strict(),
      )
      .nonempty(),
  })
  .strict()
  .superRefine((metadata, context) => {
    const names = metadata.tables.map((table) => table.name.toLowerCase());
    const invalid =
      new Set(names).size !== names.length ||
      new Set(metadata.migrations).size !== metadata.migrations.length ||
      JSON.stringify(metadata.migrationContracts.map((step) => step.id)) !==
        JSON.stringify(metadata.migrations) ||
      metadata.journalExisted !== names.includes(metadata.journalTable) ||
      metadata.tables.some(
        (table) =>
          new Set(table.columns).size !== table.columns.length ||
          new Set(table.insertColumns).size !== table.insertColumns.length ||
          table.insertColumns.some((column) => !table.columns.includes(column)),
      );
    if (invalid)
      context.addIssue({ code: "custom", message: "Invalid backup table or ledger manifest" });
  });
export type MigrationBackup = z.infer<typeof migrationBackupSchema>;

export interface SqliteMigrationsContract {
  migrate(
    db: DatabaseSync,
    migrations: readonly SqliteMigration[],
    options: MigrationOptions,
  ): Promise<MigrationResult>;
  inspect(
    db: DatabaseSync,
    migrations: readonly SqliteMigration[],
    options?: Pick<MigrationOptions, "journalTable" | "appliedAtColumn">,
  ): MigrationInspection;
  /** 停用全部写者；schema 改变时拒绝恢复，不冒充 DDL 降级。 */
  restore(db: DatabaseSync, path: string, options: RestoreOptions): Promise<void>;
}
