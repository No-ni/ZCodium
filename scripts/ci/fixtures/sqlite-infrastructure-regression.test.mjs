import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createProjectTestFixture } from "../project-test-sandbox.mjs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";

const migrationUrl = new URL(
  "../../../packages/shared/src/sqlite-migrations/index.ts",
  import.meta.url,
);
const { migrate, restore, inspectMigrations } = await tsImport(migrationUrl.href, import.meta.url);
const step = {
  id: "0001_fixture",
  appVersion: "3.16.2",
  sql: "UPDATE items SET value='new'",
  touchedTables: ["items"],
};

async function fixture(t) {
  const root = await createProjectTestFixture("sqlite-regression");
  const path = join(root, "fixture.sqlite");
  const connections = [];
  const children = [];
  const connect = () => {
    const db = new DatabaseSync(path);
    connections.push(db);
    return db;
  };
  const db = connect();
  db.exec(
    "CREATE TABLE items(id TEXT PRIMARY KEY,value TEXT); INSERT INTO items VALUES('one','old')",
  );
  t.after(async () => {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
    for (const connection of connections.toReversed()) if (connection.isOpen) connection.close();
  });
  return {
    root,
    path,
    db,
    connect,
    children,
    options: { database: "fixture", backupDirectories: [join(root, "backup")] },
  };
}

function nextMessage(child, type) {
  return new Promise((resolve, reject) => {
    const received = (message) => {
      if (message.type === type) {
        cleanup();
        resolve(message);
      }
    };
    const exited = () => {
      cleanup();
      reject(new Error(`SQLite fixture child exited before ${type}`));
    };
    const cleanup = () => {
      child.off("message", received);
      child.off("exit", exited);
      child.off("error", reject);
    };
    child.on("message", received);
    child.once("exit", exited);
    child.once("error", reject);
  });
}

test(
  "cross-process BEGIN IMMEDIATE waits asynchronously then rechecks committed ledger",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
    import { DatabaseSync } from 'node:sqlite';
    const { migrate } = await import(process.argv[3]);
    const db = new DatabaseSync(process.argv[1]);
    const step = ${JSON.stringify(step)};
    const result = await migrate(db, [step], {
      database: 'fixture', backupDirectories: [process.argv[2]],
      onBeforeApply: async () => {
        const released = new Promise(resolve => process.once('message', resolve));
        process.send({ type: 'holding' }); await released;
      }
    });
    db.close(); process.send({ type: 'result', applied: result.applied }); process.disconnect();
  `,
        f.path,
        f.options.backupDirectories[0],
        migrationUrl.href,
      ],
      {
        cwd: fileURLToPath(new URL("../../..", import.meta.url)),
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    f.children.push(child);
    child.stdout.resume();
    child.stderr.resume();
    await nextMessage(child, "holding");
    let reached;
    const waiting = new Promise((resolve) => {
      reached = resolve;
    });
    let ticks = 0;
    const timer = setInterval(() => {
      ticks++;
    }, 5);
    t.after(() => clearInterval(timer));
    const contender = migrate(f.db, [step], {
      ...f.options,
      lockWaitTimeoutMs: 5000,
      onWaitingForLock: async () => {
        await new Promise((resolve) => setImmediate(resolve));
        reached();
      },
    });
    await waiting;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(f.db.prepare("SELECT value FROM items").get().value, "old");
    assert.ok(ticks > 0, "event loop must continue while another process owns the migration lock");
    const childResult = nextMessage(child, "result");
    const exited = once(child, "exit");
    child.send({ type: "release" });
    assert.deepEqual((await childResult).applied, [step.id]);
    assert.deepEqual((await contender).applied, []);
    assert.equal((await exited)[0], 0);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM schema_migration").get().n, 1);
  },
);

test("structured SQLITE_BUSY cancellation never rolls back another connection's transaction", async (t) => {
  const f = await fixture(t);
  const owner = f.connect();
  owner.exec("BEGIN IMMEDIATE; UPDATE items SET value='owner'");
  const signal = new AbortController();
  await assert.rejects(
    migrate(f.db, [step], {
      ...f.options,
      signal: signal.signal,
      onWaitingForLock: () => signal.abort(),
    }),
  );
  assert.equal(owner.isTransaction, true);
  assert.equal(owner.prepare("SELECT value FROM items").get().value, "owner");
  assert.equal(f.db.isTransaction, false);
  owner.exec("ROLLBACK");
  assert.equal(f.db.prepare("SELECT value FROM items").get().value, "old");
});

test("backup fault executes no SQL/apply callback and writes no ledger or alias", async (t) => {
  const f = await fixture(t);
  const blocked = join(f.root, "blocked");
  await writeFile(blocked, "not a directory");
  let invoked = false;
  await assert.rejects(
    migrate(f.db, [step], {
      ...f.options,
      backupDirectories: [blocked],
      onBeforeApply: () => {
        invoked = true;
      },
    }),
    (error) => error.kind === "backup_failed",
  );
  assert.equal(invoked, false);
  assert.equal(f.db.prepare("SELECT value FROM items").get().value, "old");
  assert.equal(
    f.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='schema_migration'").get(),
    undefined,
  );
});

test("big integers, blobs, generated values and non-default rowid survive row restore", async (t) => {
  const f = await fixture(t);
  f.db.exec(
    "CREATE TABLE typed(n INTEGER,b BLOB,f REAL,g INTEGER GENERATED ALWAYS AS(n+1) STORED); INSERT INTO typed(rowid,n,b,f) VALUES(99,9007199254740993,x'00FF01',1.25)",
  );
  const before = f.db.prepare("SELECT rowid,* FROM typed");
  before.setReadBigInts(true);
  const rows = before.all();
  const result = await migrate(
    f.db,
    [{ ...step, touchedTables: ["typed"], sql: "UPDATE typed SET n=n+2,b=x'00',f=2.5" }],
    f.options,
  );
  await restore(f.db, result.backupPath, { database: "fixture", writersStopped: true });
  assert.deepEqual(before.all(), rows);
});

test("unknown ledger ids and incorrect checksums fail closed without mutation", async (t) => {
  const f = await fixture(t);
  await migrate(f.db, [step], f.options);
  f.db
    .prepare("INSERT INTO schema_migration VALUES(?,?,?,?)")
    .run("9999_future", "0".repeat(64), "future", 1);
  await assert.rejects(
    migrate(f.db, [step], f.options),
    (error) => error.kind === "schema_incompatible",
  );
  assert.throws(() => inspectMigrations(f.db, [step]));
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM schema_migration").get().n, 2);
  f.db.exec(
    "DELETE FROM schema_migration WHERE id='9999_future'; UPDATE schema_migration SET checksum='wrong'",
  );
  await assert.rejects(
    migrate(f.db, [step], f.options),
    (error) => error.kind === "checksum_mismatch",
  );
  assert.equal(f.db.prepare("SELECT value FROM items").get().value, "new");
});

test("transactionOpen transfers commit ownership exactly once and rolls back failed apply", async (t) => {
  const f = await fixture(t);
  f.db.exec("BEGIN IMMEDIATE");
  await migrate(f.db, [step], { ...f.options, transactionOpen: true });
  assert.equal(f.db.isTransaction, false);
  f.db.exec("BEGIN IMMEDIATE");
  const failure = {
    ...step,
    id: "0002_failure",
    sql: "UPDATE items SET value='broken'; INSERT INTO missing VALUES(1)",
  };
  await assert.rejects(migrate(f.db, [step, failure], { ...f.options, transactionOpen: true }));
  assert.equal(f.db.isTransaction, false);
  assert.equal(f.db.prepare("SELECT value FROM items").get().value, "new");
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM schema_migration").get().n, 1);
});

test(
  "same-process queued cancellation settles without waiting for the first owner to release",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    const second = f.connect();
    let entered;
    let release;
    const reached = new Promise((resolve) => {
      entered = resolve;
    });
    const first = migrate(f.db, [step], {
      ...f.options,
      onBeforeApply: async () => {
        entered();
        await new Promise((resolve) => {
          release = resolve;
        });
      },
    });
    await reached;
    const signal = new AbortController();
    const cancelled = migrate(second, [step], { ...f.options, signal: signal.signal });
    await new Promise((resolve) => setImmediate(resolve));
    const reason = new Error("fixture cancelled admission");
    signal.abort(reason);
    const timeout = AbortSignal.timeout(200);
    const timedOut = new Promise((resolve) =>
      timeout.addEventListener("abort", () => resolve("timeout"), { once: true }),
    );
    try {
      const result = await Promise.race([
        cancelled.then(
          () => "applied",
          (error) => error,
        ),
        timedOut,
      ]);
      assert.equal(result, reason);
      assert.equal(second.isTransaction, false);
    } finally {
      release();
      await first;
      await cancelled.catch(() => undefined);
    }
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM schema_migration").get().n, 1);
  },
);

test("large real backup yields before apply while a second connection is admitted safely", async (t) => {
  const f = await fixture(t);
  f.db.exec(
    "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<8192) INSERT INTO items SELECT 'row-'||x,'old' FROM n",
  );
  const second = f.connect();
  let ticks = 0;
  let copying = false;
  let sawRowsBeforeApply = false;
  let reached;
  const locked = new Promise((resolve) => {
    reached = resolve;
  });
  // canonical realpath 是异步 IO，调用顺序不保证锁顺序；先观测首个 owner 的锁再提交 contender。
  // Windows 计时器粒度不保证 1ms interval 运行多次；用每轮 immediate 观测真实分批 IO 的让出。
  let stopped = false;
  const observe = () => {
    if (stopped) return;
    if (copying) {
      ticks++;
      sawRowsBeforeApply ||=
        second.prepare("SELECT value FROM items WHERE id='one'").get().value === "old";
    }
    setImmediate(observe);
  };
  setImmediate(observe);
  const first = migrate(f.db, [step], {
    ...f.options,
    onLocked: () => {
      copying = true;
      reached();
    },
    onBeforeApply: () => {
      copying = false;
    },
  });
  await locked;
  const next = migrate(second, [step], f.options);
  let result;
  try {
    result = await first;
    await next;
  } finally {
    stopped = true;
  }
  assert.ok(ticks > 1, "actual SQLite snapshot/hash/copy must yield, not only a progress callback");
  assert.equal(sawRowsBeforeApply, true);
  assert.deepEqual((await next).applied, []);
  assert.ok(result.backupPath);
});

test("cancelling during real snapshot stops before copy, SQL, ledger or metadata publication", async (t) => {
  const f = await fixture(t);
  f.db.exec(
    "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<8192) INSERT INTO items SELECT 'row-'||x,'old' FROM n",
  );
  const signal = new AbortController();
  const reason = new Error("fixture cancelled snapshot");
  let applied = false;
  const migration = migrate(f.db, [step], {
    ...f.options,
    signal: signal.signal,
    onLocked: () => {
      setImmediate(() => signal.abort(reason));
    },
    onBeforeApply: () => {
      applied = true;
    },
  });
  await assert.rejects(migration, (error) => error === reason);
  assert.equal(applied, false);
  assert.equal(f.db.isTransaction, false);
  assert.equal(f.db.prepare("SELECT value FROM items WHERE id='one'").get().value, "old");
  assert.equal(
    f.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='schema_migration'").get(),
    undefined,
  );
});

test("case-insensitive touchedTables cannot skip existing rows or bypass a backup failure", async (t) => {
  const f = await fixture(t);
  const blocked = join(f.root, "blocked-case");
  await writeFile(blocked, "not a directory");
  const mixedCase = { ...step, touchedTables: ["ITEMS"] };
  await assert.rejects(
    migrate(f.db, [mixedCase], { ...f.options, backupDirectories: [blocked] }),
    (error) => error.kind === "backup_failed",
  );
  assert.equal(f.db.prepare("SELECT value FROM items").get().value, "old");
  assert.equal(
    f.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='schema_migration'").get(),
    undefined,
  );
  const result = await migrate(f.db, [mixedCase], f.options);
  assert.ok(result.backupPath);
  await restore(f.db, result.backupPath, { database: "fixture", writersStopped: true });
  assert.equal(f.db.prepare("SELECT value FROM items").get().value, "old");
});

for (const [name, change] of [
  ["checksum", "UPDATE schema_migration SET checksum='" + "0".repeat(64) + "'"],
  ["app version", "UPDATE schema_migration SET app_version='unrelated'"],
  ["ledger index", "CREATE INDEX extra_ledger_index ON schema_migration(checksum)"],
  [
    "ledger trigger",
    "CREATE TRIGGER extra_ledger_trigger AFTER DELETE ON schema_migration BEGIN UPDATE items SET value='triggered'; END",
  ],
])
  test(`restore rejects changed ${name} when the original ledger was absent`, async (t) => {
    const f = await fixture(t);
    const result = await migrate(f.db, [step], f.options);
    f.db.exec(change);
    const ledger = f.db.prepare("SELECT * FROM schema_migration").all();
    await assert.rejects(
      restore(f.db, result.backupPath, { database: "fixture", writersStopped: true }),
    );
    assert.deepEqual(f.db.prepare("SELECT * FROM schema_migration").all(), ledger);
    assert.equal(f.db.prepare("SELECT value FROM items").get().value, "new");
    assert.equal(f.db.isTransaction, false);
  });

test("restore cannot erase migrations committed after the backed-up pending set", async (t) => {
  const f = await fixture(t);
  await migrate(f.db, [step], f.options);
  const next = { ...step, id: "0002_fixture", sql: "UPDATE items SET value='next'" };
  const later = { ...step, id: "0003_fixture", sql: "UPDATE items SET value='later'" };
  const result = await migrate(f.db, [step, next], f.options);
  await migrate(f.db, [step, next, later], f.options);
  const ledger = f.db.prepare("SELECT * FROM schema_migration ORDER BY id").all();
  await assert.rejects(
    restore(f.db, result.backupPath, { database: "fixture", writersStopped: true }),
  );
  assert.deepEqual(f.db.prepare("SELECT * FROM schema_migration ORDER BY id").all(), ledger);
  assert.equal(f.db.prepare("SELECT value FROM items").get().value, "later");
});

test("invalid ledger declarations and hidden columns fail before migration writes", async (t) => {
  const f = await fixture(t);
  for (const declaration of [
    "id TEXT PRIMARY KEY,checksum TEXT NOT NULL,app_version INTEGER,time_applied INTEGER NOT NULL",
    "id TEXT PRIMARY KEY,checksum TEXT NOT NULL,app_version TEXT,time_applied INTEGER NOT NULL,hidden TEXT GENERATED ALWAYS AS(id)",
    "id TEXT PRIMARY KEY,checksum TEXT NOT NULL UNIQUE,app_version TEXT,time_applied INTEGER NOT NULL",
    "id TEXT PRIMARY KEY,checksum TEXT NOT NULL CHECK(length(checksum)=64),app_version TEXT,time_applied INTEGER NOT NULL",
    "id TEXT PRIMARY KEY,checksum TEXT NOT NULL,app_version TEXT,time_applied INTEGER NOT NULL,CHECK(time_applied>=0)",
  ]) {
    f.db.exec(`CREATE TABLE schema_migration(${declaration})`);
    await assert.rejects(
      migrate(f.db, [step], f.options),
      (error) => error.kind === "schema_incompatible",
    );
    assert.equal(f.db.prepare("SELECT value FROM items").get().value, "old");
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM schema_migration").get().n, 0);
    f.db.exec("DROP TABLE schema_migration");
  }
});

test(
  "cancelling during real backup copy never publishes metadata or runs SQL",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    f.db.exec(
      "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<32768) INSERT INTO items SELECT 'row-'||x,printf('%02048d',x) FROM n",
    );
    const signal = new AbortController();
    const reason = new Error("fixture cancelled backup copy");
    let finished = false;
    let copying = false;
    const monitor = (async () => {
      while (!finished) {
        const names = await readdir(f.options.backupDirectories[0]).catch((error) => {
          if (error.code !== "ENOENT") throw error;
          return [];
        });
        for (const name of names) {
          const file = await stat(
            join(f.options.backupDirectories[0], name, "tables.sqlite"),
          ).catch((error) => {
            if (error.code !== "ENOENT") throw error;
          });
          if (file) {
            copying = true;
            signal.abort(reason);
            return;
          }
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();
    try {
      await assert.rejects(
        migrate(f.db, [step], { ...f.options, signal: signal.signal }),
        (error) => error === reason,
      );
    } finally {
      finished = true;
      await monitor;
    }
    assert.equal(copying, true, "cancellation must occur after the actual SQLite copy file exists");
    assert.equal(f.db.prepare("SELECT value FROM items WHERE id='one'").get().value, "old");
    assert.equal(f.db.isTransaction, false);
    assert.equal(
      f.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='schema_migration'").get(),
      undefined,
    );
    for (const name of await readdir(f.options.backupDirectories[0]))
      assert.equal(
        (await readdir(join(f.options.backupDirectories[0], name))).includes("backup.json"),
        false,
      );
  },
);

test("cancelled restore while waiting for an external writer preserves both transactions and pragmas", async (t) => {
  const f = await fixture(t);
  const result = await migrate(f.db, [step], f.options);
  const owner = f.connect();
  owner.exec("BEGIN IMMEDIATE; UPDATE items SET value='owner'");
  f.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3456");
  const signal = new AbortController();
  const reason = new Error("fixture cancelled restore lock");
  await assert.rejects(
    restore(f.db, result.backupPath, {
      database: "fixture",
      writersStopped: true,
      signal: signal.signal,
      onWaitingForLock: () => signal.abort(reason),
    }),
    (error) => error === reason,
  );
  assert.equal(owner.isTransaction, true);
  assert.equal(owner.prepare("SELECT value FROM items").get().value, "owner");
  assert.equal(f.db.isTransaction, false);
  assert.equal(f.db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.equal(f.db.prepare("PRAGMA busy_timeout").get().timeout, 3456);
  owner.exec("ROLLBACK");
  assert.equal(f.db.prepare("SELECT value FROM items").get().value, "new");
});

test("restore refuses another database path even with identical schema and ledger", async (t) => {
  const f = await fixture(t);
  const other = await fixture(t);
  const result = await migrate(f.db, [step], f.options);
  await migrate(other.db, [step], other.options);
  await assert.rejects(
    restore(other.db, result.backupPath, { database: "fixture", writersStopped: true }),
  );
  assert.equal(other.db.prepare("SELECT value FROM items").get().value, "new");
  const metadata = JSON.parse(await readFile(join(result.backupPath, "backup.json"), "utf8"));
  assert.equal(metadata.database, "fixture");
});

test(
  "cancelling during real row restoration rolls back rows and ledger before rejecting",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    f.db.exec(
      "PRAGMA foreign_keys=ON; PRAGMA busy_timeout=4567; WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<16384) INSERT INTO items SELECT 'row-'||x,'old' FROM n",
    );
    const result = await migrate(f.db, [step], f.options);
    const signal = new AbortController();
    const reason = new Error("fixture cancelled row restore");
    let cancelledInTransaction = false;
    let stopped = false;
    const observe = () => {
      if (stopped) return;
      if (
        f.db.isTransaction &&
        f.db.prepare("SELECT value FROM items WHERE id='one'").get()?.value === "old"
      ) {
        cancelledInTransaction = true;
        signal.abort(reason);
        return;
      }
      setImmediate(observe);
    };
    setImmediate(observe);
    try {
      await assert.rejects(
        restore(f.db, result.backupPath, {
          database: "fixture",
          writersStopped: true,
          signal: signal.signal,
        }),
        (error) => error === reason,
      );
    } finally {
      stopped = true;
    }
    assert.equal(
      cancelledInTransaction,
      true,
      "cancel must observe real restored rows in the owner transaction",
    );
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM items WHERE value='new'").get().n, 16385);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM schema_migration").get().n, 1);
    assert.equal(f.db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
    assert.equal(f.db.prepare("PRAGMA busy_timeout").get().timeout, 4567);
    assert.equal(f.db.isTransaction, false);
  },
);

for (const change of [
  "UPDATE schema_migration SET checksum='" + "0".repeat(64) + "' WHERE id='0001_fixture'",
  "UPDATE schema_migration SET time_applied=time_applied+1 WHERE id='0001_fixture'",
])
  test("restore rejects changed original ledger values before restoring any rows", async (t) => {
    const f = await fixture(t);
    await migrate(f.db, [step], f.options);
    const next = { ...step, id: "0002_fixture", sql: "UPDATE items SET value='next'" };
    const result = await migrate(f.db, [step, next], f.options);
    f.db.exec(change);
    const ledger = f.db.prepare("SELECT * FROM schema_migration ORDER BY id").all();
    await assert.rejects(
      restore(f.db, result.backupPath, { database: "fixture", writersStopped: true }),
    );
    assert.deepEqual(f.db.prepare("SELECT * FROM schema_migration ORDER BY id").all(), ledger);
    assert.equal(f.db.prepare("SELECT value FROM items").get().value, "next");
  });

test("backup retries only caller-provided priority directories and never skips old rows", async (t) => {
  const f = await fixture(t);
  const blocked = join(f.root, "blocked-parent");
  await writeFile(blocked, "not a directory");
  const result = await migrate(f.db, [step], {
    ...f.options,
    backupDirectories: [join(blocked, "backup"), f.options.backupDirectories[0]],
  });
  assert.ok(result.backupPath.startsWith(f.options.backupDirectories[0]));
  await restore(f.db, result.backupPath, { database: "fixture", writersStopped: true });
  assert.equal(f.db.prepare("SELECT value FROM items").get().value, "old");
});

for (const [name, setup, selected] of [
  [
    "TEMP",
    "CREATE TEMP TABLE items(id TEXT PRIMARY KEY,value TEXT); INSERT INTO temp.items VALUES('one','temp-old')",
    "temp.items",
  ],
  [
    "ATTACH",
    "ATTACH DATABASE ':memory:' AS auxiliary; CREATE TABLE auxiliary.items(id TEXT PRIMARY KEY,value TEXT); INSERT INTO auxiliary.items VALUES('one','attached-old')",
    "auxiliary.items",
  ],
])
  test(`${name} connections cannot run migrations outside the main-only backup contract`, async (t) => {
    const f = await fixture(t);
    f.db.exec(setup);
    const before = f.db.prepare(`SELECT value FROM ${selected}`).get().value;
    const migration = { ...step, sql: `UPDATE ${selected} SET value='new'` };
    await assert.rejects(
      migrate(f.db, [migration], f.options),
      (error) => error.kind === "schema_incompatible",
    );
    assert.equal(f.db.prepare(`SELECT value FROM ${selected}`).get().value, before);
    assert.equal(f.db.prepare("SELECT value FROM main.items").get().value, "old");
    assert.equal(
      f.db.prepare("SELECT 1 FROM main.sqlite_schema WHERE name='schema_migration'").get(),
      undefined,
    );
  });

test("restore rejects TEMP name shadowing before it can replace active main rows", async (t) => {
  const f = await fixture(t);
  const result = await migrate(f.db, [step], f.options);
  f.db.exec(
    "CREATE TEMP TABLE items(id TEXT PRIMARY KEY,value TEXT); INSERT INTO temp.items VALUES('one','temp-new')",
  );
  await assert.rejects(
    restore(f.db, result.backupPath, { database: "fixture", writersStopped: true }),
  );
  assert.equal(f.db.prepare("SELECT value FROM main.items").get().value, "new");
  assert.equal(f.db.prepare("SELECT value FROM temp.items").get().value, "temp-new");
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM main.schema_migration").get().n, 1);
});

test("main-only scope rejection never rolls back a transaction that was not handed over", async (t) => {
  const f = await fixture(t);
  f.db.exec(
    "CREATE TEMP TABLE shadow(id TEXT); BEGIN IMMEDIATE; UPDATE main.items SET value='caller'",
  );
  await assert.rejects(migrate(f.db, [step], { ...f.options, transactionOpen: true }));
  assert.equal(f.db.isTransaction, true);
  assert.equal(f.db.prepare("SELECT value FROM main.items").get().value, "caller");
  f.db.exec("ROLLBACK");
});
