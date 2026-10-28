import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { MigrationBackup, SqliteSchemaObject } from "../contract.js";

export type TableSnapshot = MigrationBackup["tables"][number] & { values: SQLInputValue[][] };
export const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

export function identifier(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))
    throw new Error("Invalid migration SQL identifier");
  return `"${value}"`;
}

export async function contentHash(
  rows: readonly SQLInputValue[][],
  signal?: AbortSignal,
): Promise<string> {
  const encoded: string[] = [];
  for (let index = 0; index < rows.length; index++) {
    encoded.push(
      JSON.stringify(rows[index], (_key, value: unknown) => {
        if (typeof value === "bigint") return { integer: value.toString() };
        if (value instanceof Uint8Array) return { blob: Buffer.from(value).toString("hex") };
        return value;
      }),
    );
    if (index % 512 === 511) {
      await yieldToEventLoop();
      signal?.throwIfAborted();
    }
  }
  encoded.sort();
  // 大表不能将所有行一次 JSON.stringify/hash 占住事件循环；沿用排序多集 hash 格式分批写入。
  const hash = createHash("sha256").update("[");
  for (let index = 0; index < encoded.length; index++) {
    hash.update(`${index ? "," : ""}${JSON.stringify(encoded[index])}`);
    if (index % 512 === 511) {
      await yieldToEventLoop();
      signal?.throwIfAborted();
    }
  }
  signal?.throwIfAborted();
  return hash.update("]").digest("hex");
}

export function schemaObjects(db: DatabaseSync): SqliteSchemaObject[] {
  return db
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT IN ('sqlite_sequence','sqlite_stat1','sqlite_stat4') ORDER BY type,name",
    )
    .all()
    .map((row) => ({
      type: row.type as SqliteSchemaObject["type"],
      name: String(row.name),
      table: String(row.tbl_name),
      sql: row.sql === null ? null : String(row.sql),
    }));
}

export function schemaHash(objects: readonly SqliteSchemaObject[]): string {
  return createHash("sha256").update(JSON.stringify(objects)).digest("hex");
}

export async function snapshotTable(
  db: DatabaseSync,
  name: string,
  layout?: MigrationBackup["tables"][number],
  signal?: AbortSignal,
): Promise<TableSnapshot | undefined> {
  signal?.throwIfAborted();
  identifier(name);
  // SQLite 表标识符大小写不敏感；精确匹配会漏掉 ITEMS 声明对应的旧 items 行，绕过强制备份。
  const definition = db
    .prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name=? COLLATE NOCASE")
    .get(name);
  if (!definition) return undefined;
  name = String(definition.name);
  identifier(name);
  const info = db.prepare(`PRAGMA table_xinfo(${identifier(name)})`).all();
  if (info.some((column) => column.hidden === 1))
    throw new Error("Virtual tables need a dedicated migration backup");
  const columns = layout?.columns ?? info.map((row) => String(row.name));
  for (const column of columns) identifier(column);
  const insertColumns =
    layout?.insertColumns ?? info.filter((row) => row.hidden === 0).map((row) => String(row.name));
  const tableInfo = db
    .prepare("PRAGMA table_list")
    .all()
    .find((row) => row.schema === "main" && row.name === name);
  // 保留非显式主键表的 rowid；generated 列只验收、不向原表显式 INSERT。
  const rowidColumn = layout
    ? layout.rowidColumn
    : tableInfo?.wr === 1
      ? null
      : ((["rowid", "_rowid_", "oid"] as const).find(
          (alias) => !columns.some((column) => column.toLowerCase() === alias),
        ) ?? null);
  if (!layout && tableInfo?.wr !== 1 && rowidColumn === null)
    throw new Error("Shadowed SQLite rowid requires a dedicated migration backup");
  const selected = [...columns, ...(rowidColumn ? [rowidColumn] : [])];
  const statement = db.prepare(
    `SELECT ${selected.map(identifier).join(",")} FROM ${identifier(name)}`,
  );
  statement.setReadBigInts(true);
  const values: SQLInputValue[][] = [];
  for (const row of statement.iterate()) {
    values.push(selected.map((column) => row[column] as SQLInputValue));
    if (values.length % 512 === 0) {
      await yieldToEventLoop();
      signal?.throwIfAborted();
    }
  }
  return {
    name,
    schema: String(definition.sql ?? ""),
    columns,
    insertColumns,
    rowidColumn,
    rows: values.length,
    hash: await contentHash(values, signal),
    values,
  };
}

export async function insertSnapshot(
  db: DatabaseSync,
  table: TableSnapshot,
  allColumns = false,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const columns = allColumns ? table.columns : table.insertColumns;
  const selected = [...columns, ...(table.rowidColumn ? [table.rowidColumn] : [])];
  const positions = columns.map((column) => table.columns.indexOf(column));
  if (table.rowidColumn) positions.push(table.columns.length);
  const statement = db.prepare(
    `INSERT INTO ${identifier(table.name)} (${selected.map(identifier).join(",")}) VALUES (${selected.map(() => "?").join(",")})`,
  );
  for (let index = 0; index < table.values.length; index += 1) {
    statement.run(...positions.map((position) => table.values[index]![position]!));
    if (index % 512 === 511) {
      await yieldToEventLoop();
      signal?.throwIfAborted();
    }
  }
  signal?.throwIfAborted();
}
