export * from "./contract.js";
export { migrate } from "./adapters/runner.js";
export { restore } from "./adapters/restore.js";
export { inspectMigrations, migrationChecksum } from "./adapters/ledger.js";
export { retrySqliteBusy, withShortBusyTimeout } from "./adapters/coordination.js";
export { assertAdditiveSchema, dumpSqliteSchema } from "./adapters/schema-guard.js";

import { migrate } from "./adapters/runner.js";
import { restore } from "./adapters/restore.js";
import { inspectMigrations } from "./adapters/ledger.js";
import type { SqliteMigrationsContract } from "./contract.js";
// 新启动命令与既有调用共用审计后的唯一 runner。
export const sqliteMigrations: SqliteMigrationsContract = {
  migrate,
  restore,
  inspect: inspectMigrations,
};
export {
  applySqliteSchemaMigration,
  ensureSqliteSchemaMigrationTable,
  SqliteSchemaMigrationChecksumError,
  SESSION_DATABASE_IDENTITY_MIGRATION,
  runSessionDatabaseIdentityMigration,
} from "./legacy.js";
export type { SqliteSchemaMigration } from "./legacy.js";
