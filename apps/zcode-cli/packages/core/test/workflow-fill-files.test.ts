import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
  utimes,
  symlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { ZCODE_USER_DATA_DIR_NAME } from "@zcode/shared";
import {
  pruneWorkflowFillFiles,
  resolveWorkflowFillFilePath,
  resolveWorkflowFillFilesRoot,
  writeWorkflowFillFile,
} from "../src/tool/handlers/workflow-fill-files.js";

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "holes-files-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const scope = { sessionId: "session/a", runId: "run/a", holeId: "hole#12345678" };
const source = 'return "失败草稿";\n';

describe("workflow fill files — actual disk IO", () => {
  it("data root uses repository data directory name and environment override", () => {
    assert.equal(
      path.dirname(resolveWorkflowFillFilesRoot({ ZCODE_DATA_BASE_DIR: "/data" }, "/home")),
      path.join("/data", ZCODE_USER_DATA_DIR_NAME),
    );
  });
  it("writes exact bytes, concurrent reuse and edited file is never overwritten", async () =>
    withRoot(async (root) => {
      const input = { root, ...scope, holeName: "decide", source };
      const copies = await Promise.all(
        Array.from({ length: 12 }, () => writeWorkflowFillFile(input)),
      );
      const first = copies[0];
      assert.ok(first);
      assert.deepEqual(copies, Array(12).fill(first));
      assert.equal(await readFile(first, "utf8"), source);
      await writeFile(first, 'return "edited";');
      const second = await writeWorkflowFillFile(input);
      assert.ok(second);
      assert.notEqual(second, first);
      assert.equal(await readFile(first, "utf8"), 'return "edited";');
    }));
  it("long unicode labels stay writable within the filename byte limit", async () =>
    withRoot(async (root) => {
      const file = await writeWorkflowFillFile({
        root,
        ...scope,
        runName: "计划😀".repeat(100),
        holeName: "决定".repeat(100),
        source,
      });
      assert.ok(file);
      assert.ok(Buffer.byteLength(path.basename(file)) <= 255);
      assert.equal(await readFile(file, "utf8"), source);
    }));
  it("slug collisions cannot share session, run or site directories", async () =>
    withRoot(async (root) => {
      const first = await writeWorkflowFillFile({ root, ...scope, holeName: "same", source });
      assert.ok(first);
      for (const change of [
        { sessionId: "sessiona" },
        { runId: "runa" },
        { holeId: "hole#87654321" },
      ]) {
        const other = await writeWorkflowFillFile({
          root,
          ...scope,
          ...change,
          holeName: "same",
          source,
        });
        assert.ok(other);
        assert.notEqual(path.dirname(other), path.dirname(first));
        await assert.rejects(
          resolveWorkflowFillFilePath(first, root, { root, ...scope, ...change }),
          /scope/,
        );
      }
      assert.equal(await resolveWorkflowFillFilePath(first, root, { root, ...scope }), first);
    }));
  it("accepts the canonical returned path through a root alias but rejects file symlinks", async () =>
    withRoot(async (root) => {
      const configuredRoot = path.join(root, "configured-root");
      const aliasRoot = path.join(root, "root-alias");
      await mkdir(configuredRoot);
      await symlink(configuredRoot, aliasRoot, "dir");
      const file = await writeWorkflowFillFile({
        root: aliasRoot,
        ...scope,
        holeName: "decide",
        source,
      });
      assert.ok(file);
      assert.equal(
        await resolveWorkflowFillFilePath(file, root, { root: aliasRoot, ...scope }),
        file,
      );

      const outsideAlias = path.join(root, "outside-link.dwf.ts");
      await symlink(file, outsideAlias);
      await assert.rejects(
        resolveWorkflowFillFilePath(outsideAlias, root, { root: aliasRoot, ...scope }),
        /symlink/,
      );

      const insideAlias = path.join(path.dirname(file), "same-scope-link.dwf.ts");
      await symlink(file, insideAlias);
      await assert.rejects(
        resolveWorkflowFillFilePath(insideAlias, root, { root: aliasRoot, ...scope }),
        /symlink/,
      );
    }));
  it("rejects traversal and symlink escapes; malicious names stay under root", async () =>
    withRoot(async (root) => {
      const file = await writeWorkflowFillFile({
        root,
        sessionId: "../../escape",
        runId: "../run",
        holeId: "../site",
        holeName: "../../name",
        source,
      });
      assert.ok(file);
      assert.ok(!path.relative(await realpath(root), file).startsWith(".."));
      await assert.rejects(
        resolveWorkflowFillFilePath("../outside.dwf.ts", root, { root, ...scope }),
        /traversal/,
      );
      const own = await writeWorkflowFillFile({ root, ...scope, holeName: "own", source });
      assert.ok(own);
      const link = path.join(path.dirname(own), "linked.dwf.ts");
      await symlink(file, link);
      await assert.rejects(
        resolveWorkflowFillFilePath(link, root, { root, ...scope }),
        /scope|symlink/,
      );
    }));
  it("prunes only expired regular fill files, awaits cleanup and keeps the current retry", async () =>
    withRoot(async (root) => {
      const input = { root, ...scope, holeName: "old", source };
      const old = await writeWorkflowFillFile(input);
      assert.ok(old);
      await utimes(old, 1, 1);
      const note = path.join(path.dirname(old), "keep.txt");
      await writeFile(note, "keep");
      await utimes(note, 1, 1);
      const link = path.join(path.dirname(old), "keep-link.dwf.ts");
      await symlink(note, link);
      assert.equal(await pruneWorkflowFillFiles(root, { now: 10000, retentionMs: 5000 }), 1);
      assert.equal(await readFile(note, "utf8"), "keep");
      assert.equal(await readFile(link, "utf8"), "keep");
      const retry = await writeWorkflowFillFile({ ...input, now: 10000, retentionMs: 5000 });
      assert.ok(retry);
      assert.equal(await readFile(retry, "utf8"), source);
    }));
});
