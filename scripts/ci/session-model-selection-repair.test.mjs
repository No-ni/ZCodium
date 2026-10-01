import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tsImport } from "tsx/esm/api";

const { saveSessionEntry, sessionEntries } = await tsImport(
  "../../apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/session-entries.ts",
  import.meta.url,
);
const { runSqliteSessionMigrations } = await tsImport(
  "../../apps/zcode-cli/packages/adapters/src/storage/session-store/migration-runner.ts",
  import.meta.url,
);
const { SQLITE_MIGRATIONS: MIGRATIONS } = await tsImport(
  "../../apps/zcode-cli/packages/adapters/src/storage/session-store/migrations.ts",
  import.meta.url,
);
const { SESSION_ENTRY_MODEL_SELECTION } = await tsImport(
  "../../apps/zcode-cli/packages/contracts/src/interfaces/session-store.port.ts",
  import.meta.url,
);

const SESSION_ID = "sess_fixture";

async function openFixtureDb(t) {
  const directory = await mkdtemp(join(tmpdir(), "zcodium-model-selection-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dbPath = join(directory, "db.sqlite");
  const db = new DatabaseSync(dbPath);
  runSqliteSessionMigrations(db, dbPath);
  db.prepare(
    "insert into session (id, project_id, slug, directory, title, version, time_created, time_updated) values (?, 'proj', 'slug', '/tmp/x', 't', '0', 1, 1)",
  ).run(SESSION_ID);
  return db;
}

function insertRawSelectionRow(db, id, data) {
  db.prepare(
    "insert into session_entry (id, session_id, type, time_created, time_updated, data) values (?, ?, ?, 1, 1, ?)",
  ).run(id, SESSION_ID, SESSION_ENTRY_MODEL_SELECTION, data);
}

function selectionEntry(db, modelId) {
  const timestamp = Date.now();
  saveSessionEntry(db, {
    id: `${SESSION_ID}:runtime-model-selection`,
    sessionID: SESSION_ID,
    type: SESSION_ENTRY_MODEL_SELECTION,
    touchSession: false,
    time: { created: timestamp, updated: timestamp },
    data: { providerId: "prov", modelId },
  });
}

test("model selection upsert survives and self-heals a corrupted row", async (t) => {
  const db = await openFixtureDb(t);
  insertRawSelectionRow(db, `${SESSION_ID}:runtime-model-selection`, "{CORRUPTED");

  // 修复前这里必抛 malformed JSON（json_type 遇坏 JSON 直接报错），此后该会话
  // 的模型切换落盘 100% 失败；守卫加 json_valid 后坏行走 else 分支被新值覆盖。
  selectionEntry(db, "GLM-5.3-Flash");

  const rows = sessionEntries(db, { sessionID: SESSION_ID, type: SESSION_ENTRY_MODEL_SELECTION });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows.at(-1).data, { providerId: "prov", modelId: "GLM-5.3-Flash" });
});

test("migration 0023 rewrites corrupted selection rows to an explicit empty selection", async (t) => {
  const db = await openFixtureDb(t);
  insertRawSelectionRow(db, "other:runtime-model-selection", "not json at all");
  insertRawSelectionRow(
    db,
    "good:runtime-model-selection",
    JSON.stringify({ modelSelection: { providerId: "prov", modelId: "GLM-5.3-Flash" } }),
  );

  const repair = MIGRATIONS.find((m) => m.id === "0023_repair_invalid_model_selection");
  assert.ok(repair, "0023_repair_invalid_model_selection must exist in SQLITE_MIGRATIONS");
  db.exec(repair.sql);

  const bad = db
    .prepare("select data from session_entry where id = 'other:runtime-model-selection'")
    .get();
  assert.deepEqual(JSON.parse(bad.data), { modelSelection: null });
  const good = db
    .prepare("select data from session_entry where id = 'good:runtime-model-selection'")
    .get();
  assert.deepEqual(JSON.parse(good.data).modelSelection, {
    providerId: "prov",
    modelId: "GLM-5.3-Flash",
  });
});
