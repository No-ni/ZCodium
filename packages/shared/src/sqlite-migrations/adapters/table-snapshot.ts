import { createHash } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { MigrationBackup, SqliteSchemaObject } from "../contract.js";

export type TableSnapshot = MigrationBackup["tables"][number];
export type TableLayout = Omit<TableSnapshot, "rows" | "hash">;
export const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

export function identifier(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))
    throw new Error("Invalid migration SQL identifier");
  return `"${value}"`;
}

export async function contentHash(
  rows: readonly SQLInputValue[][],
  signal?: AbortSignal,
  version: MigrationBackup["version"] = 1,
): Promise<string> {
  return (await hashRows(rows, version, signal)).hash;
}

async function hashRows(
  rows: Iterable<SQLInputValue[]>,
  version: MigrationBackup["version"],
  signal?: AbortSignal,
  copy?: (row: SQLInputValue[]) => void,
): Promise<Pick<TableSnapshot, "rows" | "hash">> {
  // 根因：整表 values 与 encoded 双重驻留会在迁移 SQL 前耗尽 Worker 堆。
  // 吸收官方单行摘要算法；SQLite 临时文件排序并限制缓存，不用 :memory: 累积正文。
  const sorter = new DatabaseSync("");
  try {
    sorter.exec(
      "PRAGMA temp_store=FILE; PRAGMA cache_size=-2048; CREATE TABLE rows(sort_key BLOB,encoded TEXT); BEGIN",
    );
    const record = sorter.prepare("INSERT INTO rows VALUES (?,?)");
    let count = 0;
    for (const row of rows) {
      signal?.throwIfAborted();
      copy?.(row);
      const encoded = JSON.stringify(row, (_key, value: unknown) => {
        if (typeof value === "bigint") return { integer: value.toString() };
        if (value instanceof Uint8Array) return { blob: Buffer.from(value).toString("hex") };
        return value;
      });
      // 旧 Array.sort 按 UTF-16 码元排序；UTF-8 TEXT 排序会改变补充平面字符顺序。
      record.run(
        version === 1
          ? Buffer.from(encoded, "utf16le").swap16()
          : createHash("sha256").update(encoded).digest(),
        version === 1 ? encoded : null,
      );
      if (++count % 512 === 0) await yieldToEventLoop();
    }
    signal?.throwIfAborted();
    sorter.exec("COMMIT");
    const hash = createHash("sha256").update(version === 1 ? "[" : "sqlite-table-v2\0");
    let index = 0;
    for (const row of sorter
      .prepare("SELECT sort_key,encoded FROM rows ORDER BY sort_key")
      .iterate()) {
      if (version === 1) {
        if (index) hash.update(",");
        hash.update(JSON.stringify(row.encoded));
      } else hash.update(row.sort_key as Uint8Array);
      if (++index % 512 === 0) await yieldToEventLoop();
      signal?.throwIfAborted();
    }
    if (version === 1) hash.update("]");
    return { rows: count, hash: hash.digest("hex") };
  } finally {
    sorter.close();
  }
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

export function describeTable(
  db: DatabaseSync,
  name: string,
  layout?: TableLayout,
): TableLayout | undefined {
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
  return {
    name,
    schema: String(definition.sql ?? ""),
    columns,
    insertColumns,
    rowidColumn,
  };
}

export function* readSnapshotRows(
  db: DatabaseSync,
  table: TableLayout,
): Generator<SQLInputValue[]> {
  const selected = [...table.columns, ...(table.rowidColumn ? [table.rowidColumn] : [])];
  const statement = db.prepare(
    // INTEGER PRIMARY KEY 会让 rowid 的结果字段名变成主键名；显式 alias 保留布局键，避免复制 undefined。
    `SELECT ${selected.map((column) => `${identifier(column)} AS ${identifier(column)}`).join(",")} FROM ${identifier(table.name)}`,
  );
  statement.setReadBigInts(true);
  for (const row of statement.iterate())
    yield selected.map((column) => row[column] as SQLInputValue);
}

function snapshotInsert(db: DatabaseSync, table: TableLayout, allColumns = false) {
  const columns = allColumns ? table.columns : table.insertColumns;
  const selected = [...columns, ...(table.rowidColumn ? [table.rowidColumn] : [])];
  const positions = columns.map((column) => table.columns.indexOf(column));
  if (table.rowidColumn) positions.push(table.columns.length);
  const statement = db.prepare(
    `INSERT INTO ${identifier(table.name)} (${selected.map(identifier).join(",")}) VALUES (${selected.map(() => "?").join(",")})`,
  );
  return (row: SQLInputValue[]) => statement.run(...positions.map((position) => row[position]!));
}

export async function snapshotTable(
  db: DatabaseSync,
  name: string,
  layout?: TableLayout,
  signal?: AbortSignal,
  options: { version?: MigrationBackup["version"]; target?: DatabaseSync } = {},
): Promise<TableSnapshot | undefined> {
  signal?.throwIfAborted();
  const table = describeTable(db, name, layout);
  if (!table) return undefined;
  return {
    ...table,
    ...(await hashRows(
      readSnapshotRows(db, table),
      options.version ?? 2,
      signal,
      options.target ? snapshotInsert(options.target, table, true) : undefined,
    )),
  };
}

export async function insertSnapshot(
  source: DatabaseSync,
  target: DatabaseSync,
  table: TableLayout,
  allColumns = false,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const insert = snapshotInsert(target, table, allColumns);
  let count = 0;
  for (const row of readSnapshotRows(source, table)) {
    insert(row);
    if (++count % 512 === 0) await yieldToEventLoop();
    signal?.throwIfAborted();
  }
  signal?.throwIfAborted();
}
