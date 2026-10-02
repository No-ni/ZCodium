import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZCODE_APP_CONFIG_SUBDIR_NAME, ZCODE_USER_DATA_DIR_NAME } from "@zcode/shared";
import { copyDataDirectory } from "../src/paths.js";
import test from "node:test";

test("data directory migration overwrites stale files already at the destination", async () => {
  const sourceBaseDir = await mkdtemp(join(tmpdir(), "zcode-data-source-"));
  const targetBaseDir = await mkdtemp(join(tmpdir(), "zcode-data-target-"));
  const sourceDir = join(sourceBaseDir, ZCODE_USER_DATA_DIR_NAME, ZCODE_APP_CONFIG_SUBDIR_NAME);
  const targetDir = join(targetBaseDir, ZCODE_USER_DATA_DIR_NAME, ZCODE_APP_CONFIG_SUBDIR_NAME);

  try {
    await mkdir(sourceDir, { recursive: true });
    await mkdir(targetDir, { recursive: true });
    await writeFile(join(sourceDir, "session.db"), "current");
    await writeFile(join(targetDir, "session.db"), "stale");

    await copyDataDirectory(sourceBaseDir, targetBaseDir);

    assert.equal(await readFile(join(targetDir, "session.db"), "utf8"), "current");
  } finally {
    await Promise.all([
      rm(sourceBaseDir, { recursive: true, force: true }),
      rm(targetBaseDir, { recursive: true, force: true }),
    ]);
  }
});
