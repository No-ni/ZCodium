import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { createProjectTestFixture } from "../../../../../../scripts/ci/project-test-sandbox.mjs";
import { createWorkspaceFiles } from "#office/adapters/files.ts";

// 项目内 fresh 合成样本：不写系统临时目录，也不做整根递归清理（样本保留供事后核对，见 Office spec §9.5）。

it("reads supported workspace files without creating any data directory", async () => {
  const root = await createProjectTestFixture("office-readonly");
  const bytes = await readFile(resolve(import.meta.dirname, "../../fixtures/paper.pdf"));
  await writeFile(join(root, "sample.pdf"), bytes);
  const files = createWorkspaceFiles(root);
  const loaded = await files.load("sample.pdf");
  expect(loaded.path).toBe("sample.pdf");
  expect(loaded.bytes.byteLength).toBe(bytes.length);
  expect(loaded.revision).toMatch(/^[a-f0-9]{16}$/);
  expect(await files.fingerprint("sample.pdf")).toMatch(/^\d+:\d/);
  expect(await readdir(root)).toEqual(["sample.pdf"]);
  expect(await readFile(join(root, "sample.pdf"))).toEqual(bytes);
});

it("lists supported documents without hidden/build/lock files", async () => {
  const root = await createProjectTestFixture("office-list");
  for (const directory of ["docs", "dist", ".git", "node_modules"]) {
    await mkdir(join(root, directory));
    await writeFile(join(root, directory, "sample.pdf"), "fixture");
  }
  await writeFile(join(root, "~$sample.docx"), "fixture");
  await writeFile(join(root, "notes.txt"), "fixture");
  expect((await createWorkspaceFiles(root).list()).map((item) => item.path)).toEqual([
    "docs/sample.pdf",
  ]);
});
