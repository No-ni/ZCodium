import assert from "node:assert/strict";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { createFsStorageCleaner } from "../../../packages/services/src/storage/adapters/fsCleaner.ts";
import { walkStorageRoot } from "../../../packages/services/src/storage/adapters/fsWalker.ts";
import { createProjectTestFixture, createProjectTestSymlink } from "../project-test-sandbox.mjs";

async function fixture() {
  const base = await createProjectTestFixture("storage-boundary");
  const root = join(base, "root");
  const outside = join(base, "outside");
  await mkdir(root);
  await mkdir(outside);
  return { root, outside, cleaner: createFsStorageCleaner() };
}

async function scan(rootPath) {
  const entries = [],
    errors = [];
  const result = await walkStorageRoot({
    rootPath,
    onEntry: (entry) => entries.push(entry),
    onError: (error) => errors.push(error),
  });
  return { result, entries, errors };
}

test("a linked scan root does not enumerate its target", async () => {
  const { root, outside } = await fixture();
  const sentinel = join(outside, "sentinel.log");
  await writeFile(sentinel, "unchanged");
  const link = join(root, "linked");
  await createProjectTestSymlink(outside, link, "dir");
  const observed = await scan(link);
  assert.deepEqual(observed.entries, []);
  assert.ok(observed.errors.some((error) => error.code === "ELOOP"));
  assert.equal(await readFile(sentinel, "utf8"), "unchanged");
});

test("a linked ancestor is rejected by shallow enumeration and deletion", async () => {
  const { root, outside, cleaner } = await fixture();
  await mkdir(join(outside, "db"));
  const sentinel = join(outside, "db", "db.sqlite.backup");
  await writeFile(sentinel, "unchanged");
  await createProjectTestSymlink(outside, join(root, "cli"), "dir");
  assert.deepEqual(
    await cleaner.listCandidates(root, [{ prefix: "cli/db", recursive: false }]),
    [],
  );
  const result = await cleaner.deleteFiles(
    root,
    [{ relativePath: "cli/db/db.sqlite.backup", bytes: 9, mtimeMs: 0 }],
    { keepDirectories: ["cli/db"] },
  );
  assert.equal(result.deletedCount, 0);
  assert.deepEqual(
    result.failures.map((item) => item.code),
    ["ELOOP"],
  );
  assert.equal(await readFile(sentinel, "utf8"), "unchanged");
});

test("a linked recursive scope cannot enumerate or delete target files", async () => {
  const { root, outside, cleaner } = await fixture();
  const sentinel = join(outside, "old.log");
  await writeFile(sentinel, "unchanged");
  await createProjectTestSymlink(outside, join(root, "logs"), "dir");
  assert.deepEqual(await cleaner.listCandidates(root, [{ prefix: "logs", recursive: true }]), []);
  const result = await cleaner.deleteFiles(
    root,
    [{ relativePath: "logs/old.log", bytes: 9, mtimeMs: 0 }],
    { keepDirectories: ["logs"] },
  );
  assert.equal(result.deletedCount, 0);
  assert.equal(await readFile(sentinel, "utf8"), "unchanged");
});

test("deletion revalidates the ancestor after enumeration", async () => {
  const { root, outside, cleaner } = await fixture();
  await mkdir(join(root, "logs"));
  await writeFile(join(root, "logs", "old.log"), "original");
  const sentinel = join(outside, "old.log");
  await writeFile(sentinel, "unchanged");
  const candidates = await cleaner.listCandidates(root, [{ prefix: "logs", recursive: true }]);
  assert.equal(candidates.length, 1);
  await rename(join(root, "logs"), join(root, "original-logs"));
  await createProjectTestSymlink(outside, join(root, "logs"), "dir");
  const result = await cleaner.deleteFiles(root, candidates, { keepDirectories: ["logs"] });
  assert.equal(result.deletedCount, 0);
  assert.equal(await readFile(sentinel, "utf8"), "unchanged");
  assert.equal(await readFile(join(root, "original-logs", "old.log"), "utf8"), "original");
});

test("file metadata revalidates a directory replaced after opendir", async () => {
  const { root, outside } = await fixture();
  const logs = join(root, "logs");
  await mkdir(logs);
  await writeFile(join(logs, "old.log"), "original");
  const sentinel = join(outside, "old.log");
  await writeFile(sentinel, "outside sentinel metadata must not be read");
  const output = await createProjectTestFixture("storage-iteration-gate");
  const bundle = join(output, "walker.mjs");
  await build({
    stdin: {
      contents:
        'export { walkStorageRoot } from "./fsWalker.ts"; export { gateNextIteration } from "node:fs/promises";',
      resolveDir: resolve(import.meta.dirname, "../../../packages/services/src/storage/adapters"),
    },
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "esm",
    plugins: [
      {
        name: "pause-real-directory-iteration",
        setup(builder) {
          builder.onResolve({ filter: /^node:fs\/promises$/ }, (args) =>
            args.namespace === "fixture"
              ? { path: args.path, external: true }
              : { path: "fs", namespace: "fixture" },
          );
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents: `
          import { lstat, realpath, opendir as actualOpen } from "node:fs/promises";
          export { lstat, realpath };
          let nextGate;
          export function gateNextIteration() {
            let resume, opened;
            nextGate = { wait: new Promise(done => { resume = done; }), ready: new Promise(done => { opened = done; }), opened };
            return { resume, ready: nextGate.ready };
          }
          export async function opendir(path) {
            const directory = await actualOpen(path);
            const gate = nextGate; nextGate = undefined;
            return {
              async *[Symbol.asyncIterator]() {
                gate?.opened();
                if (gate) await gate.wait;
                for await (const entry of directory) yield entry;
              },
              close: () => directory.close(),
            };
          }
        `,
          }));
        },
      },
    ],
  });
  const { walkStorageRoot: gatedWalk, gateNextIteration } = await import(
    pathToFileURL(bundle).href
  );
  const gate = gateNextIteration();
  const entries = [],
    errors = [];
  const scanning = gatedWalk({
    rootPath: logs,
    onEntry: (entry) => entries.push(entry),
    onError: (error) => errors.push(error),
  });
  await gate.ready;
  try {
    await rename(logs, join(root, "original-logs"));
    await createProjectTestSymlink(outside, logs, "dir");
  } finally {
    gate.resume();
  }
  await scanning;
  assert.deepEqual(entries, []);
  assert.ok(errors.some((error) => error.code === "ELOOP"));
  assert.equal(await readFile(sentinel, "utf8"), "outside sentinel metadata must not be read");
  assert.equal(await readFile(join(root, "original-logs", "old.log"), "utf8"), "original");
});

test("normal nested files still scan and clean with stable byte counts", async () => {
  const { root, cleaner } = await fixture();
  await mkdir(join(root, "logs", "nested"), { recursive: true });
  await writeFile(join(root, "logs", "nested", "old.log"), "normal");
  const candidates = await cleaner.listCandidates(root, [{ prefix: "logs", recursive: true }]);
  assert.equal(candidates.length, 1);
  assert.equal((await scan(root)).entries.length, 1);
  const result = await cleaner.deleteFiles(root, candidates, { keepDirectories: ["logs"] });
  assert.equal(result.deletedCount, 1);
  assert.equal(result.freedBytes, 6);
  assert.deepEqual(result.failures, []);
});

test("missing scan roots and cleanup scopes retain empty results", async () => {
  const { root, cleaner } = await fixture();
  const observed = await scan(join(root, "missing"));
  assert.equal(observed.result.missingRoot, true);
  assert.deepEqual(observed.entries, []);
  assert.deepEqual(
    await cleaner.listCandidates(root, [
      { prefix: "missing/deep", recursive: false },
      { prefix: "absent", recursive: true },
    ]),
    [],
  );
});

test("Windows case aliases remain valid while direct outside targets fail closed", async () => {
  const { root, cleaner } = await fixture();
  await mkdir(join(root, "logs"));
  await writeFile(join(root, "logs", "..valid.log"), "normal");
  const alias = process.platform === "win32" ? root.toUpperCase() : root;
  assert.equal((await scan(alias)).entries.length, 1);
  const result = await cleaner.deleteFiles(
    root,
    [{ relativePath: "../outside/old.log", bytes: 0, mtimeMs: 0 }],
    { keepDirectories: [] },
  );
  assert.equal(result.deletedCount, 0);
  assert.deepEqual(
    result.failures.map((item) => item.code),
    ["EOUTSIDE"],
  );
});
