import assert from "node:assert/strict";
import { copyFile, link, readFile, readdir, rename, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
import {
  byteHash,
  cloneRows,
  fileManifest,
  mmapRoundTrip,
  walFixture,
} from "./fixtures/workspace-alias-wal.mjs";
const api = await tsImport(
  "../../packages/services/src/source-server-workspace/node.ts",
  import.meta.url,
);
const { readDatabase } = await tsImport(
  "../../packages/services/src/source-server-workspace/adapters/database.ts",
  import.meta.url,
);
const request = (f, signal) => ({
  dataRoot: f.root,
  databasePath: f.path,
  ...(signal ? { signal } : {}),
});
const adapter = (options) => {
  assert.equal(
    typeof api.createNodeCommittedSnapshotPort,
    "function",
    "narrow Node snapshot port must exist before any WAL claim",
  );
  return api.createNodeCommittedSnapshotPort(options);
};
async function blocked(f, options, code = "snapshot-unproven", signal) {
  let called = false;
  await assert.rejects(
    adapter(options).withSnapshot(request(f, signal), async () => {
      called = true;
    }),
    (error) => error.code === code,
  );
  assert.equal(called, false, "unproven/stale media must never reach a consumer");
}

test("OS-temp full DB/WAL/SHM clone sees committed WAL rows that a main-file clone loses", async (t) => {
  const f = await walFixture(t);
  const before = await fileManifest(f.root);
  assert.deepEqual(await cloneRows(f, false), []);
  assert.deepEqual(await cloneRows(f), [1]);
  assert.deepEqual(await fileManifest(f.root), before);
});
test("OS-temp spilled uncommitted WAL frames are not a committed snapshot", async (t) => {
  const f = await walFixture(t);
  const committed = await readFile(`${f.path}-wal`);
  f.spill();
  assert.ok(
    (await readFile(`${f.path}-wal`)).length > committed.length,
    "real writer must spill uncommitted frames",
  );
  const before = await fileManifest(f.root);
  assert.deepEqual(await cloneRows(f), [1]);
  assert.deepEqual(await fileManifest(f.root), before);
});
test("OS-temp mmap SHM bytes can change and return while endpoint identities/hash/stat stay equal", async (t) => {
  const f = await walFixture(t);
  const before = await fileManifest(f.root);
  let during;
  await mmapRoundTrip(f, async () => {
    during = await fileManifest(f.root);
  });
  assert.notDeepEqual(during, before, "mmap fixture must actually change the original SHM bytes");
  assert.deepEqual(
    await fileManifest(f.root),
    before,
    "equal endpoint file API observations do not prove a no-change interval",
  );
});
test("narrow snapshot evidence schema rejects incomplete DB-only and invented proof objects", async () => {
  assert.equal(typeof api.workspaceCommittedSnapshotEvidenceSchema?.safeParse, "function");
  assert.equal(
    api.workspaceCommittedSnapshotEvidenceSchema.safeParse({ databaseHash: "a".repeat(64) })
      .success,
    false,
  );
  assert.equal(
    api.workspaceCommittedSnapshotEvidenceSchema.safeParse({
      proof: "writersStopped",
      wal: null,
      shm: null,
    }).success,
    false,
  );
});
for (const kind of ["committed", "uncommitted"])
  test(`pure Node snapshot refuses unproven ${kind} WAL without original writes or scratch artifacts`, async (t) => {
    const f = await walFixture(t);
    if (kind === "uncommitted") f.spill();
    const before = await fileManifest(f.temp);
    await blocked(f);
    assert.deepEqual(await fileManifest(f.temp), before);
    assert.deepEqual(await readdir(f.temp), [".zcodium"]);
  });
for (const phase of ["handles-opened", "bytes-captured", "before-revalidate"])
  test(`snapshot cancellation at ${phase} closes every handle and never publishes`, async (t) => {
    const f = await walFixture(t);
    const before = await fileManifest(f.temp);
    const controller = new AbortController();
    await blocked(
      f,
      {
        afterCapturePhase(current) {
          if (current === phase) controller.abort();
        },
      },
      "cancelled",
      controller.signal,
    );
    assert.deepEqual(await fileManifest(f.temp), before);
    // Windows真实SQLite写连接本身禁止rename；先退休fixture写者，再验证adapter未留占用。
    f.writer.close();
    const moved = `${f.path}.moved`;
    await rename(f.path, moved);
    await rename(moved, f.path);
  });
for (const change of ["commit", "checkpoint", "shm"])
  test(`snapshot rejects original ${change} change during capture and never silently retries`, async (t) => {
    const f = await walFixture(t);
    let calls = 0;
    let afterWriter;
    await blocked(
      f,
      {
        async afterCapturePhase(phase) {
          if (phase !== "bytes-captured") return;
          calls++;
          if (change === "commit") f.commit();
          else if (change === "checkpoint") f.writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
          else {
            // SHM fixture要由普通文件API完成持久字节变化；Windows在线writer会锁住该介质。
            const db = await readFile(f.path);
            const wal = await readFile(`${f.path}-wal`);
            const { fixtureRead } = await import("./fixtures/workspace-alias-wal.mjs");
            const bytes = await fixtureRead(`${f.path}-shm`);
            f.writer.close();
            const { writeFile } = await import("node:fs/promises");
            await writeFile(f.path, db);
            await writeFile(`${f.path}-wal`, wal);
            bytes[116] ^= 1;
            await writeFile(`${f.path}-shm`, bytes);
          }
          afterWriter = await fileManifest(f.root);
        },
      },
      "snapshot-stale",
    );
    assert.equal(calls, 1);
    assert.deepEqual(await fileManifest(f.root), afterWriter);
  });
test("checkpoint/WAL reuse changes source salt generation even when committed rows are the same", async (t) => {
  const f = await walFixture(t);
  const first = await readFile(`${f.path}-wal`);
  f.writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  f.writer.exec("UPDATE wal_rows SET value=value");
  const second = await readFile(`${f.path}-wal`);
  assert.notEqual(byteHash(first.subarray(16, 24)), byteHash(second.subarray(16, 24)));
  const before = await fileManifest(f.root);
  await blocked(f);
  assert.deepEqual(await fileManifest(f.root), before);
});
for (const suffix of ["", "-wal", "-shm"])
  test(`snapshot refuses hardlinked ${suffix || "DB"} before observation/SQLite/scratch writes`, async (t) => {
    const f = await walFixture(t);
    await link(`${f.path}${suffix}`, join(f.temp, `outside${suffix}.sqlite`));
    const before = await fileManifest(f.temp);
    await blocked(f, undefined, "boundary-rejected");
    assert.deepEqual(await fileManifest(f.temp), before);
  });
test("snapshot refuses an ancestor junction, relative root and escaped database path", async (t) => {
  const f = await walFixture(t);
  const alias = join(f.temp, "alias");
  await symlink(f.temp, alias, "junction");
  for (const req of [
    { dataRoot: join(alias, ".zcodium"), databasePath: join(alias, ".zcodium", "fixture.sqlite") },
    { dataRoot: ".zcodium", databasePath: f.path },
    { dataRoot: f.root, databasePath: join(f.temp, "outside.sqlite") },
  ])
    await assert.rejects(
      adapter().withSnapshot(req, async () => assert.fail("escaped consumer")),
      (error) => error.code === "boundary-rejected",
    );
  await rm(alias);
});
test("snapshot refuses missing SHM without creating a sidecar on the original", async (t) => {
  const f = await walFixture(t);
  const db = await readFile(f.path);
  const wal = await readFile(`${f.path}-wal`);
  f.writer.close();
  const { writeFile } = await import("node:fs/promises");
  await writeFile(f.path, db);
  await writeFile(`${f.path}-wal`, wal);
  const before = await fileManifest(f.temp);
  await blocked(f);
  assert.deepEqual(await fileManifest(f.temp), before);
});
test("default original WAL read path remains safely blocked, not redirected to an unproved clone", async (t) => {
  const f = await walFixture(t);
  const before = await fileManifest(f.root);
  await assert.rejects(
    readDatabase(f.root, f.path),
    (error) => error.code === "schema-incompatible",
  );
  assert.deepEqual(await fileManifest(f.root), before);
});
test("snapshot capture IO failure closes handles and leaves no artifacts", async (t) => {
  const f = await walFixture(t);
  const before = await fileManifest(f.temp);
  await blocked(
    f,
    {
      afterCapturePhase(phase) {
        if (phase === "bytes-captured")
          throw Object.assign(new Error("fixture IO"), { code: "ENOSPC" });
      },
    },
    "storage-full",
  );
  assert.deepEqual(await fileManifest(f.temp), before);
  const copied = join(f.temp, "copy.sqlite");
  await copyFile(f.path, copied);
  const db = new DatabaseSync(copied, { readOnly: true });
  db.close();
  await rm(copied);
});
