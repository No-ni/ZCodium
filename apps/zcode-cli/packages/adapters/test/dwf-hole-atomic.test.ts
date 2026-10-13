import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { createDwfJournalStore } from "../src/storage/session-store/repositories/dwf-journal.js";
import { runSqliteSessionMigrations } from "../src/storage/session-store/migration-runner.js";

it("real SQLite trigger failure rolls back script/hash and event; nested transaction succeeds once", () => {
  const db = new DatabaseSync(":memory:");
  try {
    runSqliteSessionMigrations(db, ":memory:");
    const journal = createDwfJournalStore(db);
    journal.createRun({
      runId: "run-1",
      scriptText: "old",
      scriptHash: "old-hash",
      status: "running",
      caps: { maxConcurrency: 1 },
      spentTokens: 0,
    });
    const before = journal.getRun("run-1");
    const event = {
      type: "hole-filled" as const,
      siteId: "hole#12345678",
      filledAt: 1,
      phaseNames: ["A"],
    };
    db.exec(
      `create trigger reject_fill before insert on dwf_event when new.type = 'hole-filled' begin select raise(abort, 'injected append failure'); end;`,
    );
    assert.throws(
      () => journal.commitHoleFill("run-1", "new", "new-hash", event),
      /injected append failure/,
    );
    assert.deepEqual(journal.getRun("run-1"), before);
    assert.deepEqual(journal.listEvents("run-1"), []);
    db.exec("drop trigger reject_fill; BEGIN");
    const first = journal.commitHoleFill("run-1", "new", "new-hash", event);
    db.exec("COMMIT");
    assert.equal(journal.listEvents("run-1").length, 1);
    assert.equal(first.sequence, journal.listEvents("run-1")[0]?.sequence);
    assert.equal(journal.getRun("run-1")?.scriptHash, "new-hash");
    const second = journal.commitHoleFill("run-1", "newer", "newer-hash", {
      ...event,
      siteId: "hole#87654321",
    });
    assert.ok(second.sequence > first.sequence);
    assert.equal(journal.listEvents("run-1").length, 2);
  } finally {
    db.close();
  }
});
