import assert from "node:assert/strict";
import { constants } from "node:buffer";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tsImport } from "tsx/esm/api";
import { assertProjectPath } from "../project-test-sandbox.mjs";

const { migrate, restore } = await tsImport(
  new URL("../../../packages/shared/src/sqlite-migrations/index.ts", import.meta.url).href,
  import.meta.url,
);
const root = await assertProjectPath(process.argv[2]);
const path = await assertProjectPath(join(root, "source.sqlite"));
const payload = "x".repeat(8192);
const rows = Math.ceil((constants.MAX_STRING_LENGTH + 1024 * 1024) / payload.length);
let db = new DatabaseSync(path);
try {
  db.exec(
    "PRAGMA cache_size=-2048; CREATE TABLE part(id INTEGER PRIMARY KEY,data TEXT); CREATE TABLE untouched(value TEXT); INSERT INTO untouched VALUES('preserved'); BEGIN",
  );
  const insert = db.prepare("INSERT INTO part VALUES (?,?)");
  for (let id = 0; id < rows; id++) insert.run(id, payload);
  db.exec("COMMIT");
  const result = await migrate(
    db,
    [
      {
        id: "0001_large",
        appVersion: "synthetic",
        touchedTables: ["part"],
        sql: "UPDATE part SET data='migrated' WHERE id=0",
      },
    ],
    { database: "cli", backupDirectories: [join(root, "backup")] },
  );
  assert.ok(result.backupPath);
  const metadata = JSON.parse(await readFile(join(result.backupPath, "backup.json"), "utf8"));
  assert.equal(metadata.version, 2);
  assert.equal(metadata.tables[0].rows, rows);
  assert.equal(db.prepare("SELECT data FROM part WHERE id=0").get().data, "migrated");
  db.close();
  db = new DatabaseSync(path);
  db.exec("PRAGMA cache_size=-2048");
  await restore(db, result.backupPath, { database: "cli", writersStopped: true });
  assert.equal(db.prepare("SELECT count(*) AS n FROM part").get().n, rows);
  assert.equal(db.prepare("SELECT count(*) AS n FROM part WHERE data<>?").get(payload).n, 0);
  assert.equal(db.prepare("SELECT value FROM untouched").get().value, "preserved");
  assert.equal(
    db.prepare("SELECT 1 FROM sqlite_schema WHERE name='schema_migration'").get(),
    undefined,
  );
  assert.equal(db.prepare("PRAGMA quick_check").get().quick_check, "ok");
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  console.log(
    JSON.stringify({
      rows,
      bytes: rows * payload.length,
      maxStringLength: constants.MAX_STRING_LENGTH,
      maxRssKiB: process.resourceUsage().maxRSS,
    }),
  );
} finally {
  db.close();
}
