import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSessionId } from "@zcode/contracts";
import { zcodeMessageWithPartsSchema } from "@zcode/shared";
import { SQLITE_MIGRATIONS } from "../../adapters/src/storage/session-store/migrations.js";
import { createSqliteSessionStore } from "../../adapters/src/storage/session-store/sqlite-session-store.js";
import { mapMessageWithParts as oldMap } from "../../adapters/tests/fixtures/staging-backup-model-readers.mjs";
import { TASK_INDEX_SCHEMA } from "../../../../../packages/services/src/session/tasksDatabase/schema-v1.js";
import { mapMessageWithParts } from "../src/zcode-protocol/message-mapper.js";

const exec = promisify(execFile);
const migrationId = "0020_provider_model_selection";
const sessionID = createSessionId("rollback-readable-session");
const restoreScript = fileURLToPath(
  new URL(
    "../../restore-legacy-sessions-plugin/skills/restore-legacy-sessions/scripts/restore-conversation.mjs",
    import.meta.url,
  ),
);

describe("DB109：配置可失效，回滚和再升级的内容读取不可报错", () => {
  let root: string;
  let path: string;
  let db: DatabaseSync;
  let store: Awaited<ReturnType<typeof createSqliteSessionStore>> | undefined;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "zcode-readability-"));
    path = join(root, "session.sqlite");
    db = new DatabaseSync(path);
    db.exec(
      "CREATE TABLE schema_migration(id TEXT PRIMARY KEY, checksum TEXT NOT NULL, app_version TEXT, time_applied INTEGER NOT NULL)",
    );
    for (const migration of SQLITE_MIGRATIONS.filter((item) => item.id < migrationId)) {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migration VALUES(?,?,?,?)").run(
        migration.id,
        createHash("sha256").update(migration.sql.trim()).digest("hex"),
        migration.appVersion,
        1,
      );
    }
    db.prepare(
      "INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES(?,?,?,?,?,?,?,?)",
    ).run(sessionID, "project", "old", root, "会话标题", "old", 1, 2);
  });
  afterEach(async () => {
    store?.close();
    store = undefined;
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  function seedMessage(id: string, extra: Record<string, unknown>) {
    db.prepare(
      "INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?)",
    ).run(
      id,
      sessionID,
      1,
      2,
      JSON.stringify({ role: "user", time: { created: 1 }, agent: "main", ...extra }),
    );
    db.prepare(
      "INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?,?)",
    ).run(`${id}-body`, id, sessionID, 1, 2, JSON.stringify({ type: "text", text: `正文-${id}` }));
  }

  async function readCurrent() {
    const messages = await store!.messages({ sessionID });
    return messages.map((message) =>
      zcodeMessageWithPartsSchema.parse(mapMessageWithParts(message)),
    );
  }

  function readOld() {
    return db
      .prepare("SELECT * FROM message WHERE session_id=? ORDER BY id")
      .all(sessionID)
      .map((row) => {
        const info = { ...JSON.parse(String(row.data)), id: row.id, sessionID: row.session_id };
        const parts = db
          .prepare("SELECT * FROM part WHERE message_id=? ORDER BY id")
          .all(row.id)
          .map((part) => ({
            ...JSON.parse(String(part.data)),
            id: part.id,
            messageID: part.message_id,
            sessionID: part.session_id,
          }));
        return oldMap({ info, parts });
      });
  }

  it("真实 migration 的不可转换 User 投影为缺失，旧快照、正文和账本保持", async () => {
    for (const [id, model] of Object.entries({
      empty: {},
      partial: { providerID: "p" },
      valid: { providerID: "historical", modelID: "m" },
    })) {
      seedMessage(id, { model });
    }
    const before = readOld();
    store = await createSqliteSessionStore({ dbPath: path });
    const current = await readCurrent();
    expect(current).toHaveLength(3);
    for (const message of current) {
      expect(message.parts).toEqual([
        expect.objectContaining({ text: `正文-${message.info.messageId}` }),
      ]);
      expect(message.info.model).toEqual(
        message.info.messageId === "valid" ? { providerId: "historical", modelId: "m" } : undefined,
      );
    }
    expect(readOld()).toEqual(before);
    const disk = db.prepare("SELECT * FROM message ORDER BY id").all();
    const ledger = db.prepare("SELECT * FROM schema_migration ORDER BY id").all();
    store.close();
    store = await createSqliteSessionStore({ dbPath: path });
    expect(await readCurrent()).toEqual(current);
    expect(db.prepare("SELECT * FROM message ORDER BY id").all()).toEqual(disk);
    expect(db.prepare("SELECT * FROM schema_migration ORDER BY id").all()).toEqual(ledger);
  });

  it.each([
    undefined,
    null,
    {},
    { providerId: "p" },
    { providerId: "p", modelId: "m", options: { reasoningLevel: 3 } },
  ])("已记账后出现无效新选择 %j：不回读旧值，不阻断协议，内容保留", async (modelSelection) => {
    store = await createSqliteSessionStore({ dbPath: path });
    const ledger = db.prepare("SELECT * FROM schema_migration ORDER BY id").all();
    store.close();
    store = undefined;
    seedMessage("after-rollback", {
      model: { providerID: "old-p", modelID: "old-m" },
      modelSelection,
    });
    for (const [id, value] of Object.entries({
      timeline: {
        type: "timeline",
        timelineType: "model_change",
        display: "separator",
        toModel: {},
        toModelSelection: modelSelection,
      },
      subtask: {
        type: "subtask",
        prompt: "子任务正文",
        description: "说明",
        agent: "worker",
        model: {},
        modelSelection,
      },
    })) {
      db.prepare(
        "INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?,?)",
      ).run(id, "after-rollback", sessionID, 1, 2, JSON.stringify(value));
    }
    const old = readOld();
    const disk = db.prepare("SELECT * FROM message ORDER BY id").all();
    store = await createSqliteSessionStore({ dbPath: path });
    const [message] = await readCurrent();
    expect(message.info.model).toBeUndefined();
    expect(message.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text", text: "正文-after-rollback" }),
        expect.objectContaining({ type: "subagent", prompt: "子任务正文" }),
        expect.objectContaining({ type: "timeline", timelineType: "model_change" }),
      ]),
    );
    expect(JSON.stringify(message)).not.toContain("old-p");
    expect(readOld()).toEqual(old);
    expect(db.prepare("SELECT * FROM message ORDER BY id").all()).toEqual(disk);
    expect(db.prepare("SELECT * FROM schema_migration ORDER BY id").all()).toEqual(ledger);
  });

  it("退役 restore CLI 明确拒绝，现存正文、两库与迁移账本不变", async () => {
    seedMessage("before-refused-restore", {model: {providerID: "old-p", modelID: "old-m"}});
    store = await createSqliteSessionStore({dbPath: path});
    const ledger = db.prepare("SELECT * FROM schema_migration ORDER BY id").all();
    store.close(); store = undefined;
    const taskPath = join(root, "tasks.sqlite");
    const tasks = new DatabaseSync(taskPath);
    tasks.exec(TASK_INDEX_SCHEMA);
    tasks.exec("ALTER TABLE tasks ADD COLUMN searchable_text TEXT NOT NULL DEFAULT ''");
    tasks.close();
    const snapshot = join(root, "snapshot.json");
    await writeFile(snapshot, JSON.stringify({meta: {taskId: sessionID, workspacePath: root}, messages: [{role: "user", content: "未导入正文", timestamp: 1}]}));
    const old = readOld();
    const before = await Promise.all([readFile(path), readFile(taskPath), readFile(snapshot)]);
    await expect(exec(process.execPath, [restoreScript, "--snapshot", snapshot, "--task-index", taskPath, "--cli-db", path])).rejects.toMatchObject({
      code: 2, stderr: expect.stringContaining("LEGACY_RESTORE_UNAVAILABLE"),
    });
    expect(await Promise.all([readFile(path), readFile(taskPath), readFile(snapshot)])).toEqual(before);
    expect(readOld()).toEqual(old);
    store = await createSqliteSessionStore({dbPath: path});
    expect((await readCurrent()).flatMap(message => message.parts).filter(part => part.type === "text").map(part => part.text)).toEqual(["正文-before-refused-restore"]);
    expect(db.prepare("SELECT * FROM schema_migration ORDER BY id").all()).toEqual(ledger);
  });
});
