import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { tsImport } from "tsx/esm/api";
import { createProjectTestFixture } from "../project-test-sandbox.mjs";

const { migrate, restore } = await tsImport(
  new URL("../../../packages/shared/src/sqlite-migrations/index.ts", import.meta.url).href,
  import.meta.url,
);
const step = {
  id: "0001_change",
  appVersion: "synthetic",
  sql: "UPDATE item SET value='changed'",
  touchedTables: ["item"],
};
async function fixture(t) {
  const root = await createProjectTestFixture("streaming-backup");
  const db = new DatabaseSync(join(root, "source.sqlite"));
  db.exec("CREATE TABLE item(value,detail)");
  t.after(() => {
    if (db.isOpen) db.close();
  });
  const options = { database: "cli", backupDirectories: [join(root, "backup")] };
  return { root, db, options };
}

test(
  "96 MiB heap backs up and restores data exceeding the V8 string limit",
  { timeout: 190_000 },
  async (t) => {
    const root = await createProjectTestFixture("streaming-large-process");
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "--max-old-space-size=96",
        "--import",
        "tsx",
        fileURLToPath(new URL("./sqlite-streaming-process.mjs", import.meta.url)),
        root,
      ],
      { env: process.env, windowsHide: true, timeout: 180_000, maxBuffer: 1024 * 1024 },
    );
    const report = JSON.parse(stdout.trim());
    assert.ok(report.bytes > report.maxStringLength);
    assert.ok(report.rows > 60_000);
    t.diagnostic(JSON.stringify(report));
  },
);

test("v2 hashes preserve duplicate rows and rowids independently of insertion order", async (t) => {
  const hashes = [];
  for (const rows of [
    [
      [1, "a"],
      [2, "b"],
      [3, "a"],
    ],
    [
      [3, "a"],
      [1, "a"],
      [2, "b"],
    ],
    [
      [1, "a"],
      [2, "b"],
    ],
  ]) {
    const f = await fixture(t);
    for (const [id, value] of rows)
      f.db.prepare("INSERT INTO item(rowid,value) VALUES (?,?)").run(id, value);
    const result = await migrate(f.db, [step], f.options);
    const metadata = JSON.parse(await readFile(join(result.backupPath, "backup.json"), "utf8"));
    assert.equal(metadata.version, 2);
    hashes.push(metadata.tables[0].hash);
    await restore(f.db, result.backupPath, { database: "cli", writersStopped: true });
    assert.deepEqual(
      f.db
        .prepare("SELECT rowid,value FROM item ORDER BY rowid")
        .all()
        .map((row) => [row.rowid, row.value]),
      [...rows].sort((a, b) => a[0] - b[0]),
    );
  }
  assert.equal(hashes[0], hashes[1]);
  assert.notEqual(hashes[0], hashes[2]);
});

test("v1 backup retains UTF-16 ordering, exact integers, blobs and rowids", async (t) => {
  const f = await fixture(t);
  const rows = [
    ["\uE000", null],
    ["😀", 9223372036854775807n],
    ['a"\\\n', new Uint8Array([0, 255])],
    ['a"\\\n', new Uint8Array([0, 255])],
    ["real", 1.25],
  ];
  for (const row of rows) f.db.prepare("INSERT INTO item VALUES (?,?)").run(...row);
  const result = await migrate(f.db, [step], f.options);
  const metadataPath = join(result.backupPath, "backup.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  metadata.version = 1;
  const backup = new DatabaseSync(join(result.backupPath, "tables.sqlite"));
  try {
    for (const table of metadata.tables) {
      const columns = [...table.columns, ...(table.rowidColumn ? [table.rowidColumn] : [])];
      const select = backup.prepare(
        `SELECT ${columns.map((c) => `"${c}"`).join(",")} FROM "${table.name}"`,
      );
      select.setReadBigInts(true);
      const encoded = select
        .all()
        .map((row) =>
          JSON.stringify(
            columns.map((c) => row[c]),
            (_key, value) =>
              typeof value === "bigint"
                ? { integer: value.toString() }
                : value instanceof Uint8Array
                  ? { blob: Buffer.from(value).toString("hex") }
                  : value,
          ),
        )
        .sort();
      table.hash = createHash("sha256").update(JSON.stringify(encoded)).digest("hex");
    }
    const encoded = JSON.stringify(metadata);
    backup.prepare("UPDATE _zcodium_migration_backup SET metadata=? WHERE id=1").run(encoded);
    await writeFile(metadataPath, encoded);
  } finally {
    backup.close();
  }
  await restore(f.db, result.backupPath, { database: "cli", writersStopped: true });
  const select = f.db.prepare("SELECT value,detail FROM item ORDER BY rowid");
  select.setReadBigInts(true);
  const actual = select
    .all()
    .map((row) => [
      row.value,
      row.detail instanceof Uint8Array ? Array.from(row.detail) : row.detail,
    ]);
  assert.deepEqual(
    actual,
    rows.map((row) => [row[0], row[1] instanceof Uint8Array ? Array.from(row[1]) : row[1]]),
  );
});

test("v2 backup tampering is rejected before original rows or ledger change", async (t) => {
  const f = await fixture(t);
  f.db.prepare("INSERT INTO item VALUES (?,?)").run("original", null);
  const result = await migrate(f.db, [step], f.options);
  const backup = new DatabaseSync(join(result.backupPath, "tables.sqlite"));
  backup.exec("UPDATE item SET value='tampered'");
  backup.close();
  await assert.rejects(restore(f.db, result.backupPath, { database: "cli", writersStopped: true }));
  assert.equal(f.db.prepare("SELECT value FROM item").get().value, "changed");
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM schema_migration").get().n, 1);
});

test("unknown backup format fails closed", async (t) => {
  const f = await fixture(t);
  f.db.prepare("INSERT INTO item VALUES (?,?)").run("original", null);
  const result = await migrate(f.db, [step], f.options);
  const path = join(result.backupPath, "backup.json");
  const metadata = JSON.parse(await readFile(path, "utf8"));
  metadata.version = 3;
  await writeFile(path, JSON.stringify(metadata));
  await assert.rejects(restore(f.db, result.backupPath, { database: "cli", writersStopped: true }));
  assert.equal(f.db.prepare("SELECT value FROM item").get().value, "changed");
});
