import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const generator = fileURLToPath(
  new URL("../../apps/zcode-cli/scripts/generate-bash-command-registry.mjs", import.meta.url),
);
const generated = fileURLToPath(
  new URL(
    "../../apps/zcode-cli/packages/core/src/tool/handlers/generated/bash-command-registry.ts",
    import.meta.url,
  ),
);

async function sourceHash(directory, separator, entries) {
  const text = await readFile(generator, "utf8");
  const source = ts.createSourceFile(
    generator,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const functions = source.statements.filter(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "hashBuildFiles",
  );
  assert.equal(functions.length, 1);
  const bytes = new Map(
    entries.map(([path, value]) => [
      `${directory}${separator}${path.split("/").join(separator)}`,
      Buffer.from(value),
    ]),
  );
  const hash = new Function(
    "createHash",
    "listFiles",
    "readFile",
    "sep",
    `${functions[0].getText(source)}; return hashBuildFiles;`,
  )(
    createHash,
    async () => [...bytes.keys()],
    async (path) => {
      assert.ok(bytes.has(path));
      return bytes.get(path);
    },
    separator,
  );
  return hash(directory);
}

const entries = [
  ["a.js", "fixture-alpha"],
  ["nested/b.js", "fixture-beta"],
];

test("production registry source hash uses the same path encoding on Windows and POSIX", async () => {
  const windows = await sourceHash("C:\\fixture\\build", "\\", entries);
  const posix = await sourceHash("/fixture/build", "/", entries);
  assert.equal(windows, posix);
});

test("registry source hash still covers contents, relative paths and sorted file order", async () => {
  const original = await sourceHash("/fixture/build", "/", entries);
  for (const changed of [
    [["a.js", "changed"], entries[1]],
    [entries[0], ["other/b.js", "fixture-beta"]],
    entries.toReversed(),
  ])
    assert.notEqual(await sourceHash("/fixture/build", "/", changed), original);
});

test(
  "real fixed Fig registry check succeeds without rewriting the generated module",
  { timeout: 120000 },
  async () => {
    const before = await readFile(generated);
    await run(process.execPath, [generator, "--check"], {
      cwd: root,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    assert.deepEqual(await readFile(generated), before);
  },
);
