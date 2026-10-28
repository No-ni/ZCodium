import { chmod, open } from "node:fs/promises";
import { DatabaseSync, backup, type SQLInputValue } from "node:sqlite";
import {
  dumpSqliteSchema,
  retrySqliteBusy,
  withShortBusyTimeout,
} from "@zcode/shared/sqlite-migrations";
import { WorkspaceAliasError } from "../contract.js";
import type { Cell, DatabaseImage, DatabaseJournalImage, TableImage } from "../domain/images.js";
import { assertSafePath, bytesHash, hash, openSafe, yieldLoop, type SafeFile } from "./files.js";

export const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
function encode(value: unknown): Cell {
  if (typeof value === "bigint") return { integer: String(value) };
  if (value instanceof Uint8Array) return { blob: Buffer.from(value).toString("base64") };
  if (value === null || typeof value === "string" || typeof value === "number") return value;
  throw new WorkspaceAliasError("schema-incompatible");
}
function decode(value: Cell): SQLInputValue {
  if (value && typeof value === "object")
    return "integer" in value ? BigInt(value.integer) : Buffer.from(value.blob, "base64");
  return value;
}
export async function databaseImage(
  db: DatabaseSync,
  identity: string,
  signal?: AbortSignal,
): Promise<DatabaseImage> {
  // 异步yield会释放单条SELECT的读锁；显式事务保证各表属于同一个committed snapshot。
  const ownSnapshot = !db.isTransaction;
  if (ownSnapshot) db.exec("BEGIN");
  try {
    return await captureDatabaseImage(db, identity, signal);
  } finally {
    if (ownSnapshot && db.isTransaction) db.exec("ROLLBACK");
  }
}
async function captureDatabaseImage(
  db: DatabaseSync,
  identity: string,
  signal?: AbortSignal,
): Promise<DatabaseImage> {
  if (
    db
      .prepare("PRAGMA database_list")
      .all()
      .some((row) => row.name !== "main" && row.name !== "temp") ||
    db.prepare("SELECT 1 FROM temp.sqlite_schema LIMIT 1").get()
  )
    throw new WorkspaceAliasError("schema-incompatible");
  const tables: TableImage[] = [];
  for (const definition of db
    .prepare(
      "SELECT name,sql FROM main.sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_stat%' ORDER BY name",
    )
    .all()) {
    const name = String(definition.name);
    const info = db.prepare(`PRAGMA main.table_xinfo(${quote(name)})`).all();
    if (!definition.sql || info.some((column) => column.hidden === 1))
      throw new WorkspaceAliasError("schema-incompatible");
    const columns = info.map((column) => String(column.name));
    const insertColumns = info
      .filter((column) => column.hidden === 0)
      .map((column) => String(column.name));
    const wr =
      db
        .prepare("PRAGMA main.table_list")
        .all()
        .find((row) => row.name === name)?.wr === 1;
    const rowidColumn = wr
      ? null
      : (["rowid", "_rowid_", "oid"].find(
          (candidate) => !columns.some((column) => column.toLowerCase() === candidate),
        ) ?? null);
    if (!wr && !rowidColumn) throw new WorkspaceAliasError("schema-incompatible");
    const selected = [...columns, ...(rowidColumn ? [rowidColumn] : [])];
    const statement = db.prepare(
      `SELECT ${selected.map(quote).join(",")} FROM main.${quote(name)}`,
    );
    statement.setReadBigInts(true);
    const rows: Cell[][] = [];
    for (const row of statement.iterate()) {
      rows.push(selected.map((column) => encode(row[column])));
      if (rows.length % 256 === 0) {
        await yieldLoop();
        signal?.throwIfAborted();
      }
    }
    if (name !== "sqlite_sequence") {
      const key = rowidColumn
        ? [columns.length]
        : info
            .filter((column) => Number(column.pk) > 0)
            .map((column) => columns.indexOf(String(column.name)));
      if (
        !key.length ||
        rows.some((row) => key.some((position) => row[position] === null)) ||
        new Set(rows.map((row) => hash(key.map((position) => row[position])))).size !== rows.length
      )
        throw new WorkspaceAliasError("schema-incompatible");
    }
    rows.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    tables.push({
      name,
      sql: String(definition.sql),
      columns,
      insertColumns,
      primaryKey: info
        .filter((column) => Number(column.pk) > 0)
        .sort((left, right) => Number(left.pk) - Number(right.pk))
        .map((column) => String(column.name)),
      rowidColumn,
      rows,
    });
  }
  signal?.throwIfAborted();
  return { exists: true, identity, schema: dumpSqliteSchema(db), tables };
}
export async function guardDatabase(root: string, path: string, write = false): Promise<SafeFile> {
  const file = await openSafe(root, path, write);
  try {
    const header = Buffer.alloc(100);
    await file.handle.read(header, 0, header.length, 0);
    let recovery = header[18] === 2 || header[19] === 2;
    // ReadOnly仍会更新WAL SHM读标记；零写预检必须在SQLite打开前拒绝，不能忽略WAL。
    for (const suffix of ["-wal", "-shm"])
      if (await assertSafePath(root, `${path}${suffix}`, true)) recovery = true;
    if (await assertSafePath(root, `${path}-journal`, true)) {
      const journal = await openSafe(root, `${path}-journal`);
      try {
        const magic = Buffer.alloc(8);
        const result = await journal.handle.read(magic, 0, magic.length, 0);
        // 全零magic是未落盘事务的cold journal，实测readonly不改介质；非零header禁止隐式recovery。
        if (result.bytesRead !== magic.length || magic.some((byte) => byte !== 0)) recovery = true;
        await journal.assertCurrent();
      } finally {
        await journal.handle.close();
      }
    }
    if (recovery) throw new WorkspaceAliasError("schema-incompatible");
    return file;
  } catch (error) {
    await file.handle.close();
    throw error;
  }
}
export async function readDatabase(
  root: string,
  path: string,
  signal?: AbortSignal,
): Promise<DatabaseImage> {
  if (!(await assertSafePath(root, path, true)))
    return { exists: false, identity: "absent", schema: "", tables: [] };
  const file = await guardDatabase(root, path);
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec("BEGIN");
    if (
      db
        .prepare("PRAGMA quick_check")
        .all()
        .some((row) => row.quick_check !== "ok")
    )
      throw new WorkspaceAliasError("schema-incompatible");
    const image = await databaseImage(db, file.identity, signal);
    await file.assertCurrent();
    return image;
  } finally {
    if (db?.isTransaction) db.exec("ROLLBACK");
    db?.close();
    await file.handle.close();
  }
}
export function databaseDigest(image: DatabaseImage): string {
  return hash({
    exists: image.exists,
    identity: image.identity,
    schema: image.schema,
    tables: image.tables.map((table) => ({
      ...table,
      rows: [...table.rows].sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      ),
    })),
  });
}
export async function begin(db: DatabaseSync, signal?: AbortSignal): Promise<void> {
  await retrySqliteBusy(() => db.exec("BEGIN IMMEDIATE"), { signal, lockWaitTimeoutMs: 30_000 });
}
export async function writeImage(
  db: DatabaseSync,
  before: DatabaseImage,
  after: DatabaseImage,
  signal?: AbortSignal,
): Promise<void> {
  if (before.schema !== after.schema) throw new WorkspaceAliasError("schema-incompatible");
  const changed = after.tables.filter(
    (table) =>
      hash(table.rows) !== hash(before.tables.find((value) => value.name === table.name)?.rows),
  );
  // 普通trigger不是外键，禁用foreign_keys也不会停它；逐行差量写入避免触发未变更记录的业务副作用。
  for (const table of changed) {
    const old = before.tables.find((value) => value.name === table.name)!;
    const key = (row: Cell[]) =>
      table.rowidColumn
        ? hash(row[table.columns.length])
        : hash(table.primaryKey.map((column) => row[table.columns.indexOf(column)]));
    const previous = new Map(old.rows.map((row) => [key(row), row]));
    const next = new Map(table.rows.map((row) => [key(row), row]));
    const selected = [...table.insertColumns, ...(table.rowidColumn ? [table.rowidColumn] : [])];
    const positions = table.insertColumns.map((column) => table.columns.indexOf(column));
    if (table.rowidColumn) positions.push(table.columns.length);
    const keyColumns = table.rowidColumn ? [table.rowidColumn] : table.primaryKey;
    const keyPositions = table.rowidColumn
      ? [table.columns.length]
      : keyColumns.map((column) => table.columns.indexOf(column));
    const predicate = keyColumns.map((column) => `${quote(column)} IS ?`).join(" AND ");
    const remove = db.prepare(`DELETE FROM main.${quote(table.name)} WHERE ${predicate}`);
    const update = db.prepare(
      `UPDATE main.${quote(table.name)} SET ${selected.map((column) => `${quote(column)}=?`).join(",")} WHERE ${predicate}`,
    );
    const insert = db.prepare(
      `INSERT INTO main.${quote(table.name)}(${selected.map(quote).join(",")}) VALUES(${selected.map(() => "?").join(",")})`,
    );
    let count = 0;
    for (const [identity, row] of previous)
      if (!next.has(identity))
        remove.run(...keyPositions.map((position) => decode(row[position]!)));
    for (const [identity, row] of next) {
      const beforeRow = previous.get(identity);
      if (beforeRow && hash(beforeRow) === hash(row)) continue;
      const values = positions.map((position) => decode(row[position]!));
      if (beforeRow)
        update.run(...values, ...keyPositions.map((position) => decode(beforeRow[position]!)));
      else insert.run(...values);
      if (++count % 256 === 0) {
        await yieldLoop();
        signal?.throwIfAborted();
      }
    }
  }
  if (db.prepare("PRAGMA main.foreign_key_check").all().length)
    throw new WorkspaceAliasError("state-diverged");
}
export async function createBackup(
  root: string,
  source: string,
  target: string,
  expected: DatabaseImage,
  signal?: AbortSignal,
): Promise<string> {
  const sourceFile = await guardDatabase(root, source);
  let db: DatabaseSync | undefined;
  try {
    if (sourceFile.identity !== expected.identity) throw new WorkspaceAliasError("state-diverged");
    await assertSafePath(root, target, true);
    const reserved = await open(target, "wx", 0o600);
    await reserved.close();
    db = new DatabaseSync(source, { readOnly: true });
    await backup(db, target, { rate: 64, progress: () => signal?.throwIfAborted() });
    await sourceFile.assertCurrent();
  } finally {
    db?.close();
    await sourceFile.handle.close();
  }
  signal?.throwIfAborted();
  await chmod(target, 0o600);
  const copy = await readDatabase(root, target, signal);
  copy.identity = expected.identity;
  if (databaseDigest(copy) !== databaseDigest(expected))
    throw new WorkspaceAliasError("backup-failed");
  const handle = await open(target, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  return databaseDigest(copy);
}
export async function databaseJournal(
  root: string,
  path: string,
  signal?: AbortSignal,
): Promise<DatabaseJournalImage> {
  const database = await openSafe(root, path);
  const journal = await openSafe(root, `${path}-journal`);
  try {
    const image = {
      databaseIdentity: database.identity,
      databaseHash: bytesHash(await database.handle.readFile()),
      journalIdentity: journal.identity,
      journalHash: bytesHash(await journal.handle.readFile()),
    };
    signal?.throwIfAborted();
    await database.assertCurrent();
    await journal.assertCurrent();
    return image;
  } finally {
    await database.handle.close();
    await journal.handle.close();
  }
}
export async function recoverDatabaseJournal(
  root: string,
  path: string,
  intent: DatabaseJournalImage,
  expected: DatabaseImage,
  assertCurrent: () => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (!(await assertSafePath(root, `${path}-journal`, true))) return;
  const current = await databaseJournal(root, path, signal);
  if (hash(current) !== hash(intent) || current.databaseIdentity !== expected.identity)
    throw new WorkspaceAliasError("state-diverged");
  for (const suffix of ["-wal", "-shm"])
    if (await assertSafePath(root, `${path}${suffix}`, true))
      throw new WorkspaceAliasError("schema-incompatible");
  const file = await openSafe(root, path, true);
  let db: DatabaseSync | undefined;
  try {
    const header = Buffer.alloc(100);
    await file.handle.read(header, 0, header.length, 0);
    if (header[18] === 2 || header[19] === 2) throw new WorkspaceAliasError("schema-incompatible");
    await assertCurrent();
    // 只有本job提交前冻结的完整文件/journal指纹能授权SQLite撤回其未提交事务；getter永不走此入口。
    db = new DatabaseSync(path);
    await begin(db, signal);
    const image = await databaseImage(db, file.identity, signal);
    if (databaseDigest(image) !== databaseDigest(expected))
      throw new WorkspaceAliasError("state-diverged");
    await file.assertCurrent();
    await assertCurrent();
    // 非hot journal可能仍留在磁盘；经独立IMMEDIATE事务与postimage验收后交由SQLite自身收口，不手删。
    db.exec("COMMIT");
  } finally {
    if (db?.isTransaction) db.exec("ROLLBACK");
    db?.close();
    await file.handle.close();
  }
}
export async function withDatabaseWrite<T>(
  root: string,
  path: string,
  operation: (db: DatabaseSync, identity: string, assertCurrent: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const file = await guardDatabase(root, path, true);
  let db: DatabaseSync | undefined;
  let foreignKeys = 0;
  try {
    db = new DatabaseSync(path);
    foreignKeys = Number(db.prepare("PRAGMA foreign_keys").get()?.foreign_keys ?? 0);
    db.exec("PRAGMA foreign_keys=OFF");
    const result = await withShortBusyTimeout(db, () =>
      operation(db!, file.identity, file.assertCurrent),
    );
    await file.assertCurrent();
    return result;
  } finally {
    if (db?.isTransaction) db.exec("ROLLBACK");
    db?.exec(`PRAGMA foreign_keys=${foreignKeys}`);
    db?.close();
    await file.handle.close();
  }
}
