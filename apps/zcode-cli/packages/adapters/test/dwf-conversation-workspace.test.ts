import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { runSqliteSessionMigrations } from "../src/storage/session-store/migration-runner.js";
import { createDwfJournalStore } from "../src/storage/session-store/repositories/dwf-journal.js";
import { listRuns } from "../src/storage/session-store/repositories/dwf-journal-introspection.js";

it("lists independent conversation runs by their persisted parent workspace without changing execution cwd", () => {
  const db = new DatabaseSync(":memory:");
  try {
    runSqliteSessionMigrations(db, ":memory:");
    const root = "/workspace/default";
    const journal = createDwfJournalStore(db);
    for (const [id, directory, cwd, name, status, updated] of [
      ["a", root, `${root}/2026-10-13/aaaaaaaa`, "chosen", "completed", 3],
      ["b", root, `${root}/2026-10-13/bbbbbbbb`, "chosen", "running", 2],
      ["c", "/workspace/other", "/workspace/other", "chosen", "completed", 4],
      ["d", root, `${root}/2026-10-13/dddddddd`, "different", "completed", 5],
    ] as const) {
      db.prepare(
        "insert into session (id,project_id,slug,directory,path,title,version,time_created,time_updated) values (?,?,?,?,?,?,?,?,?)",
      ).run(id, "project", id, directory, cwd, id, "1", 1, 1);
      journal.createRun({
        runId: id,
        parentSessionId: id,
        cwd,
        name,
        status,
        spentTokens: 0,
        caps: { maxConcurrency: 1 },
      });
      db.prepare("update dwf_run set time_updated = ? where id = ?").run(updated, id);
    }
    assert.deepEqual(
      listRuns(db, { cwd: root, name: "chosen", limit: 10 }).map((run) => [run.runId, run.cwd]),
      [
        ["a", `${root}/2026-10-13/aaaaaaaa`],
        ["b", `${root}/2026-10-13/bbbbbbbb`],
      ],
    );
    assert.deepEqual(
      listRuns(db, { cwd: root, name: "chosen", statuses: ["running"], limit: 1 }).map(
        (run) => run.runId,
      ),
      ["b"],
    );
    assert.deepEqual(
      listRuns(db, { cwd: root, name: "chosen", limit: 1 }).map((run) => run.runId),
      ["a"],
    );
    assert.deepEqual(
      listRuns(db, { cwd: `${root}/2026-10-13/aaaaaaaa`, limit: 10 }).map((run) => run.runId),
      ["a"],
    );
    assert.equal(listRuns(db, { limit: 10 }).length, 4);
    assert.equal(listRuns(db, { cwd: `${root}-unrelated`, limit: 10 }).length, 0);
  } finally {
    db.close();
  }
});
