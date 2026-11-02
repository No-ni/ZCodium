import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  MigrationChecksumError,
  type MigrationInspection,
  type MigrationOptions,
  type SqliteMigration,
} from "../contract.js";
import { tableDeclaration } from "./schema-guard.js";
import { identifier } from "./table-snapshot.js";

type JournalOptions = Pick<
  MigrationOptions,
  "journalTable" | "appliedAtColumn" | "recognizedMigrations"
>;
const RESERVED_TABLES = new Set([
  "schema_migration",
  "tasks_schema_migration",
  "_zcodium_migration_backup",
]);
const MIGRATION_ID = /^[A-Za-z_0-9-]{1,128}$/;

export function migrationChecksum(step: SqliteMigration): string {
  return step.checksum ?? createHash("sha256").update(step.sql.trim()).digest("hex");
}

export function validateMigrations(migrations: readonly SqliteMigration[]): void {
  if (!Array.isArray(migrations)) throw new Error("Migration set must be an array");
  const ids = new Set<string>();
  for (const step of migrations) {
    if (!step || typeof step.sql !== "string" || typeof step.appVersion !== "string")
      throw new Error("Invalid migration definition");
    if (step.previousIds !== undefined && !Array.isArray(step.previousIds))
      throw new Error("Migration previousIds must be an array");
    for (const id of [step.id, ...(step.previousIds ?? [])]) {
      if (typeof id !== "string" || !MIGRATION_ID.test(id) || ids.has(id))
        throw new Error("Migration identifiers and aliases must be globally unique");
      ids.add(id);
    }
    if (!Array.isArray(step.touchedTables) || !step.touchedTables.length)
      throw new Error("Migration requires valid touchedTables");
    const tables = new Set<string>();
    for (const table of step.touchedTables) {
      identifier(table);
      const key = table.toLowerCase();
      if (tables.has(key) || RESERVED_TABLES.has(key) || key.startsWith("sqlite_"))
        throw new Error("Migration requires distinct non-reserved touchedTables");
      tables.add(key);
    }
    if (
      step.checksum !== undefined &&
      (typeof step.checksum !== "string" || !/^[a-f0-9]{64}$/.test(step.checksum))
    )
      throw new Error("Migration checksum must be SHA-256");
    if (
      step.apply !== undefined &&
      (typeof step.apply !== "function" || step.checksum === undefined)
    )
      throw new Error("TypeScript migration requires a frozen semantic checksum");
  }
}

export function journalSettings(options: JournalOptions = {}) {
  const name = options.journalTable ?? "schema_migration";
  if (name !== "schema_migration" && name !== "tasks_schema_migration")
    throw new Error("Invalid migration journal");
  const appliedAt =
    name === "tasks_schema_migration"
      ? "time_applied"
      : (options.appliedAtColumn ?? "time_applied");
  if (appliedAt !== "time_applied" && appliedAt !== "applied_at")
    throw new Error("Invalid migration applied-at column");
  return { name, appliedAt, taskJournal: name === "tasks_schema_migration" };
}

export function assertMigrationJournalSchema(
  db: DatabaseSync,
  options: JournalOptions = {},
): boolean {
  const { name, appliedAt, taskJournal } = journalSettings(options);
  const definition = db
    .prepare("SELECT type,sql FROM sqlite_schema WHERE name=? COLLATE NOCASE")
    .get(name);
  if (!definition) return false;
  if (definition.type !== "table") throw incompatible();
  const declaration = tableDeclaration(String(definition.sql));
  const columnDeclarations: readonly (readonly [string, readonly string[]])[] = [
    ["id", ["text", "primary", "key"]],
    ["checksum", ["text", "not", "null"]],
    ...(!taskJournal ? [["app_version", ["text"]] as const] : []),
    [appliedAt, ["integer", "not", "null"]],
  ];
  if (
    declaration.constraints.length ||
    declaration.suffix !== "[]" ||
    columnDeclarations.some(
      ([column, tokens]) => declaration.columns.get(column) !== JSON.stringify(tokens),
    )
  )
    throw incompatible();
  const expected = [
    { name: "id", type: "TEXT", pk: 1, notnull: 0 },
    { name: "checksum", type: "TEXT", pk: 0, notnull: 1 },
    ...(!taskJournal ? [{ name: "app_version", type: "TEXT", pk: 0, notnull: 0 }] : []),
    { name: appliedAt, type: "INTEGER", pk: 0, notnull: 1 },
  ];
  // table_info 隐藏 generated 列，原验收漏掉额外列/约束会让损坏账本继续写入。
  const info = db.prepare(`PRAGMA table_xinfo(${identifier(name)})`).all();
  if (
    info.length !== expected.length ||
    info.some((column, index) => {
      const contract = expected[index]!;
      return (
        column.name !== contract.name ||
        column.type !== contract.type ||
        column.pk !== contract.pk ||
        column.notnull !== contract.notnull ||
        column.dflt_value !== null ||
        column.hidden !== 0
      );
    })
  )
    throw incompatible();
  const keys = db
    .prepare(`PRAGMA index_list(${identifier(name)})`)
    .all()
    .filter((index) => index.origin !== "c");
  if (
    keys.length !== 1 ||
    keys[0]?.origin !== "pk" ||
    keys[0]?.unique !== 1 ||
    keys[0]?.partial !== 0
  )
    throw incompatible();
  const key = db
    .prepare(`PRAGMA index_xinfo(${identifier(String(keys[0]!.name))})`)
    .all()
    .filter((column) => column.key);
  if (
    key.length !== 1 ||
    key[0]?.name !== "id" ||
    key[0]?.desc !== 0 ||
    key[0]?.coll !== "BINARY" ||
    db.prepare(`PRAGMA foreign_key_list(${identifier(name)})`).all().length
  )
    throw incompatible();
  return true;
}

export function inspectMigrations(
  db: DatabaseSync,
  migrations: readonly SqliteMigration[],
  options: JournalOptions = {},
): MigrationInspection {
  const catalog = [...migrations, ...(options.recognizedMigrations ?? [])];
  validateMigrations(catalog);
  const { name, appliedAt, taskJournal } = journalSettings(options);
  const exists = assertMigrationJournalSchema(db, options);
  const rows = exists
    ? db
        .prepare(
          `SELECT id,checksum,${taskJournal ? "" : "app_version,"}${identifier(appliedAt)} AS applied_at FROM ${identifier(name)}`,
        )
        .all()
    : [];
  // 同账本合法 scope 共享验收目录，执行/pending 仍只来自本次 migrations。
  const known = new Map(
    catalog.flatMap((step) =>
      [step.id, ...(step.previousIds ?? [])].map((id) => [id, step] as const),
    ),
  );
  const applied = new Set<string>();
  for (const row of rows) {
    if (
      typeof row.id !== "string" ||
      typeof row.checksum !== "string" ||
      !Number.isSafeInteger(row.applied_at) ||
      (!taskJournal && row.app_version !== null && typeof row.app_version !== "string")
    )
      throw incompatible();
    const step = known.get(row.id);
    if (!step) throw incompatible();
    if (row.checksum !== migrationChecksum(step)) throw new MigrationChecksumError(row.id);
    applied.add(step.id);
  }
  const pending = migrations.filter((step) => !applied.has(step.id)).map((step) => step.id);
  const hasTables = db
    .prepare(
      "SELECT 1 FROM sqlite_schema WHERE type='table' AND name NOT IN (?, 'sqlite_sequence') LIMIT 1",
    )
    .get(name);
  const last =
    rows
      .map((row) => String(row.id))
      .sort()
      .at(-1) ?? null;
  return {
    kind: pending.length ? (hasTables ? "upgrade" : "initialize") : "none",
    pending,
    lastAppliedMigrationId: last,
  };
}

export function createMigrationJournal(db: DatabaseSync, options: JournalOptions): void {
  const { name, appliedAt, taskJournal } = journalSettings(options);
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${identifier(name)} (id TEXT PRIMARY KEY,checksum TEXT NOT NULL,${taskJournal ? "" : "app_version TEXT,"}${identifier(appliedAt)} INTEGER NOT NULL)`,
  );
}

function incompatible(): Error {
  return Object.assign(
    new Error("Database migration ledger is incompatible with this migration set"),
    { kind: "schema_incompatible" },
  );
}
