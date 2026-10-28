import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFileService } from "../src/file/fileService.js";

test("workspace index drains all directories discovered after the root scan", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "zcode-workspace-scan-"));
  try {
    for (const name of Array.from({ length: 12 }, (_, index) => `branch-${index}`)) {
      const directory = join(rootPath, name);
      await mkdir(directory);
      await writeFile(join(directory, `${name}.txt`), name);
    }

    const entries = await createFileService().searchWorkspaceFiles({
      rootPath,
      query: "branch-",
      limit: 100,
    });
    const files = entries.filter((entry) => entry.relativePath.endsWith(".txt"));

    assert.equal(files.length, 12);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("public readdir preserves hidden filtering, directory-first ordering and empty reads", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "zcode-directory-read-"));
  try {
    for (const name of ["z-dir", ".hidden-dir", "a-dir"]) await mkdir(join(rootPath, name));
    for (const name of ["z.txt", ".hidden.txt", "a.txt"])
      await writeFile(join(rootPath, name), name);
    const service = createFileService();
    const expected = (names: string[]) =>
      names.map((name) => ({
        name,
        path: join(rootPath, name),
        type: name.endsWith("dir") ? "directory" : "file",
        isSymbolicLink: false,
      }));
    assert.deepEqual(
      await service.readdir({ path: rootPath }),
      expected(["a-dir", "z-dir", "a.txt", "z.txt"]),
    );
    assert.deepEqual(
      await service.readdir({ path: rootPath, includeHidden: true }),
      expected([".hidden-dir", "a-dir", "z-dir", ".hidden.txt", "a.txt", "z.txt"]),
    );
    assert.deepEqual(await service.readdir({ path: join(rootPath, "a-dir") }), []);
    await assert.rejects(service.readdir({ path: join(rootPath, "missing") }), { code: "ENOENT" });
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});
