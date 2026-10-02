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
