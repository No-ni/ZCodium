import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const { assertAdditiveSchema, dumpSqliteSchema } = await tsImport(
  "../../packages/shared/src/sqlite-migrations/index.ts",
  import.meta.url,
);
const baseline =
  "CREATE TABLE tasks(workspace_key TEXT,task_id TEXT,PRIMARY KEY(workspace_key,task_id)); CREATE INDEX task_idx ON tasks(task_id);";

test("additive schema accepts nullable and non-null default additions, preserving composite identity", () => {
  assert.doesNotThrow(() =>
    assertAdditiveSchema(
      baseline,
      baseline +
        "ALTER TABLE tasks ADD COLUMN project_id TEXT; ALTER TABLE tasks ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;",
    ),
  );
});

for (const [name, sql] of [
  ["removed column", "CREATE TABLE tasks(task_id TEXT); CREATE INDEX task_idx ON tasks(task_id);"],
  [
    "changed composite identity",
    "CREATE TABLE tasks(workspace_key TEXT,task_id TEXT PRIMARY KEY); CREATE INDEX task_idx ON tasks(task_id);",
  ],
  [
    "required column without default",
    baseline + "ALTER TABLE tasks ADD COLUMN host TEXT NOT NULL;",
  ],
  [
    "required column with NULL default",
    baseline + "ALTER TABLE tasks ADD COLUMN host TEXT NOT NULL DEFAULT NULL;",
  ],
  [
    "removed index",
    "CREATE TABLE tasks(workspace_key TEXT,task_id TEXT,PRIMARY KEY(workspace_key,task_id));",
  ],
])
  test(`additive schema rejects ${name}`, () =>
    assert.throws(() => assertAdditiveSchema(baseline, sql)));

test("automatic UNIQUE keys and primary key preserve order, sorting and collation", () => {
  const old = "CREATE TABLE tasks(id TEXT, title TEXT COLLATE NOCASE, UNIQUE(id,title DESC));";
  for (const sql of [
    "CREATE TABLE tasks(id TEXT,title TEXT COLLATE NOCASE);",
    "CREATE TABLE tasks(id TEXT,title TEXT,UNIQUE(id,title DESC));",
    "CREATE TABLE tasks(id TEXT,title TEXT COLLATE NOCASE,UNIQUE(id,title ASC));",
    "CREATE TABLE tasks(id TEXT,title TEXT COLLATE NOCASE,UNIQUE(title DESC,id));",
  ])
    assert.throws(() => assertAdditiveSchema(old, sql));
  assert.doesNotThrow(() =>
    assertAdditiveSchema(old, old + "ALTER TABLE tasks ADD COLUMN extra TEXT;"),
  );
  assert.throws(() =>
    assertAdditiveSchema(
      "CREATE TABLE tasks(id TEXT PRIMARY KEY DESC);",
      "CREATE TABLE tasks(id TEXT PRIMARY KEY ASC);",
    ),
  );
  assert.throws(() =>
    assertAdditiveSchema(
      "CREATE TABLE tasks(id TEXT COLLATE NOCASE PRIMARY KEY);",
      "CREATE TABLE tasks(id TEXT PRIMARY KEY);",
    ),
  );
});

test("CHECK and partial index literals preserve case while SQL syntax whitespace is normalized", () => {
  const old =
    "CREATE TABLE tasks(id TEXT CHECK(length(id)>0), phase TEXT CHECK(phase<>'CHECK(fake)'));";
  assert.throws(() => assertAdditiveSchema(old, "CREATE TABLE tasks(id TEXT,phase TEXT);"));
  assert.throws(() =>
    assertAdditiveSchema(old, old + "ALTER TABLE tasks ADD COLUMN extra TEXT CHECK(extra<>'x');"),
  );
  assert.throws(() =>
    assertAdditiveSchema(
      "CREATE TABLE tasks(phase TEXT CHECK(phase='COMPLETE'));",
      "CREATE TABLE tasks(phase TEXT CHECK(phase='complete'));",
    ),
  );
  const table = "CREATE TABLE tasks(id TEXT, phase TEXT);";
  assert.throws(() =>
    assertAdditiveSchema(
      table + "CREATE INDEX status ON tasks(id) WHERE phase='COMPLETE';",
      table + "CREATE INDEX status ON tasks(id) WHERE phase='complete';",
    ),
  );
  assert.doesNotThrow(() =>
    assertAdditiveSchema(
      table + "CREATE INDEX status ON tasks(id) WHERE phase='complete';",
      table + "create index status on tasks(id) where phase = 'complete';",
    ),
  );
});

test("composite foreign key grouping, order and deferrability cannot silently change", () => {
  const parent = "CREATE TABLE parents(a TEXT,b TEXT,UNIQUE(a,b));";
  const old =
    parent +
    "CREATE TABLE children(a TEXT,b TEXT,FOREIGN KEY(a,b) REFERENCES parents(a,b) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED);";
  for (const next of [
    parent +
      "CREATE TABLE children(a TEXT REFERENCES parents(a) ON DELETE CASCADE,b TEXT REFERENCES parents(b) ON DELETE CASCADE);",
    parent +
      "CREATE TABLE children(a TEXT,b TEXT,FOREIGN KEY(b,a) REFERENCES parents(b,a) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED);",
    parent +
      "CREATE TABLE children(a TEXT,b TEXT,FOREIGN KEY(a,b) REFERENCES parents(a,b) ON DELETE CASCADE NOT DEFERRABLE);",
    parent +
      "CREATE TABLE children(a TEXT,b TEXT,FOREIGN KEY(a,b) REFERENCES parents(a,b) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED);",
  ])
    assert.throws(() => assertAdditiveSchema(old, next));
  assert.doesNotThrow(() =>
    assertAdditiveSchema(old, old + "ALTER TABLE children ADD COLUMN extra TEXT;"),
  );
});

test("table STRICT/WITHOUT ROWID, generated expressions and existing view/trigger contracts remain stable", () => {
  assert.throws(() =>
    assertAdditiveSchema(
      "CREATE TABLE tasks(id TEXT PRIMARY KEY) WITHOUT ROWID;",
      "CREATE TABLE tasks(id TEXT PRIMARY KEY);",
    ),
  );
  assert.throws(() =>
    assertAdditiveSchema("CREATE TABLE tasks(id TEXT) STRICT;", "CREATE TABLE tasks(id TEXT);"),
  );
  assert.throws(() =>
    assertAdditiveSchema(
      "CREATE TABLE tasks(id INTEGER,g INTEGER GENERATED ALWAYS AS(id+1));",
      "CREATE TABLE tasks(id INTEGER,g INTEGER GENERATED ALWAYS AS(id+2));",
    ),
  );
  const old =
    "CREATE TABLE tasks(id TEXT); CREATE VIEW task_ids AS SELECT id FROM tasks; CREATE TRIGGER task_trigger AFTER INSERT ON tasks BEGIN SELECT 1; END;";
  assert.throws(() => assertAdditiveSchema(old, "CREATE TABLE tasks(id TEXT);"));
  assert.throws(() =>
    assertAdditiveSchema(
      old,
      "CREATE TABLE tasks(id TEXT); CREATE VIEW task_ids AS SELECT id FROM tasks; CREATE TRIGGER task_trigger AFTER INSERT ON tasks BEGIN SELECT 2; END;",
    ),
  );
  assert.doesNotThrow(() =>
    assertAdditiveSchema(old, old + "ALTER TABLE tasks ADD COLUMN extra TEXT;"),
  );
});

test("schema dump is deterministic and round-trips actual SQLite objects", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(baseline);
    const sql = dumpSqliteSchema(db);
    assert.equal(dumpSqliteSchema(db), sql);
    assert.doesNotThrow(() => assertAdditiveSchema(baseline, sql));
    assert.doesNotThrow(() => assertAdditiveSchema(sql, baseline));
  } finally {
    db.close();
  }
});
