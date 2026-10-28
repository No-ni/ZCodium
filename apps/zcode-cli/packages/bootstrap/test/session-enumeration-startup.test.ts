import assert from "node:assert/strict";
import { mkdir, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { openStartupSqliteSessionStore, SqliteSessionStore } from "@zcode/adapters/storage";
import { createProjectId, createSessionId, type SessionStorePort } from "@zcode/contracts";
import { resolveSourceDataRoots } from "@zcode/shared/node";
import { listZCodeSessions, resolveLatestSession } from "../src/sessions.js";
import { createProjectTestFixture } from "../../../../../scripts/ci/project-test-sandbox.mjs";

async function fixture(t: TestContext) {
  const temp = await createProjectTestFixture("session-enumeration");
  const home = join(temp, "home");
  await mkdir(home);
  const keys = ["HOME", "USERPROFILE", "ZCODE_DESKTOP_HOME_DIR"] as const;
  const previous = keys.map((key) => [key, process.env[key]] as const);
  t.after(async () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  // 默认配置可迁移写回；真实进程 home 必须先隔离，注入 env 字典不能代替此保护。
  for (const key of keys) process.env[key] = home;
  assert.equal(homedir(), home);
  const roots = resolveSourceDataRoots(join(temp, "source"));
  const env = { HOME: home, USERPROFILE: home, ZCODE_SERVER_ROOT: roots.serverRoot };
  return { temp, home, roots, env };
}

for (const method of ["list", "latest"] as const) {
  test(`${method} awaits first Source database startup before enumeration`, async (t) => {
    const f = await fixture(t);
    if (method === "list") assert.deepEqual(await listZCodeSessions({ env: f.env }), []);
    else assert.equal(await resolveLatestSession({ directory: f.temp, env: f.env }), null);
    assert.ok((await stat(f.roots.sessionDatabasePath)).isFile());
    assert.deepEqual(await readdir(f.home), []);
  });
}

test("session enumeration reopens the selected Source and keeps root, directory and limit filters", async (t) => {
  const f = await fixture(t);
  const directory = join(f.temp, "workspace");
  const otherDirectory = join(f.temp, "other-workspace");
  const ids = ["root-old", "root-new", "child-newest", "other-directory"].map(createSessionId);
  const store = await openStartupSqliteSessionStore({ dbPath: f.roots.sessionDatabasePath });
  try {
    for (const [index, id] of ids.entries()) {
      await store.createSession({
        id,
        projectID: createProjectId("fixture-project"),
        slug: String(id),
        directory: index === 3 ? otherDirectory : directory,
        title: String(id),
        version: "fixture",
        ...(index === 2 ? { parentID: ids[1] } : {}),
        time: { created: 100 + index, updated: 100 + index },
      });
    }
  } finally {
    store.close();
  }
  assert.deepEqual(
    (await listZCodeSessions({ env: f.env, directory, limit: 1 })).map(({ id }) => id),
    [ids[1]],
  );
  assert.equal((await resolveLatestSession({ env: f.env, directory }))?.id, ids[1]);
  assert.deepEqual(
    (await listZCodeSessions({ env: f.env })).map(({ id }) => id),
    [ids[3], ids[1], ids[0]],
  );
  const otherRoots = resolveSourceDataRoots(join(f.temp, "source-b"));
  const envB = { ...f.env, ZCODE_SERVER_ROOT: otherRoots.serverRoot };
  assert.deepEqual(await listZCodeSessions({ env: envB }), []);
  assert.equal(await resolveLatestSession({ directory, env: envB }), null);
  assert.equal((await resolveLatestSession({ env: f.env, directory }))?.id, ids[1]);
  assert.deepEqual(await readdir(f.home), []);
});

for (const method of ["list", "latest"] as const) {
  test(`${method} closes its own prepared store when enumeration fails`, async (t) => {
    const f = await fixture(t);
    const reason = new Error("fixture owned query failure");
    let opened: SqliteSessionStore | undefined;
    let closes = 0;
    const close = SqliteSessionStore.prototype.close;
    t.mock.method(SqliteSessionStore.prototype, "listSessions", async function (this: SqliteSessionStore) {
      opened = this;
      throw reason;
    });
    t.mock.method(SqliteSessionStore.prototype, "close", function (this: SqliteSessionStore) {
      closes++;
      close.call(this);
    });
    const query = () =>
      method === "list"
        ? listZCodeSessions({ env: f.env })
        : resolveLatestSession({ directory: f.temp, env: f.env });
    await assert.rejects(query, (error: unknown) => error === reason);
    assert.equal(closes, 1);
    assert.ok(opened);
    await assert.rejects(opened.getSession(createSessionId("fixture-missing")));
    assert.deepEqual(await readdir(f.home), []);
  });
}

for (const fails of [false, true]) {
  test(`borrowed session stores are not configured or closed when queries ${fails ? "fail" : "succeed"}`, async (t) => {
    const f = await fixture(t);
    const calls: unknown[] = [];
    let closes = 0;
    const reason = new Error("fixture query failure");
    const borrowed = {
      listSessions: async (input: unknown) => {
        calls.push(input);
        if (fails) throw reason;
        return [];
      },
      close: () => closes++,
    };
    const sessionStore = borrowed as unknown as SessionStorePort;
    const env = { ZCODE_SERVER_ROOT: "invalid-relative-root" };
    const list = () => listZCodeSessions({ sessionStore, env, directory: f.temp, limit: 7 });
    const latest = () => resolveLatestSession({ sessionStore, env, directory: f.temp });
    if (fails) {
      await assert.rejects(list, (error: unknown) => error === reason);
      await assert.rejects(latest, (error: unknown) => error === reason);
    } else {
      assert.deepEqual(await list(), []);
      assert.equal(await latest(), null);
    }
    assert.deepEqual(calls, [
      { directory: f.temp, limit: 7, roots: true },
      { directory: f.temp, limit: 1, roots: true },
    ]);
    assert.equal(closes, 0);
    assert.deepEqual(await readdir(f.home), []);
  });
}
