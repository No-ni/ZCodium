import { resolve } from "node:path";
import { expect, it } from "vitest";
import { createDocumentOwner } from "#office/app/documents.ts";
import { createWorkspaceFiles } from "#office/adapters/files.ts";
it("keeps view reports separate and never picks the last writer when ambiguous", async () => {
  const owner = createDocumentOwner({
    files: createWorkspaceFiles(resolve(import.meta.dirname, "../../fixtures")),
    parse: async () => {
      throw new Error("not needed");
    },
  }).session();
  await owner.report({ viewId: "first", path: "paper.pdf", at: "page:1" });
  await owner.report({ viewId: "second", path: "report.docx", at: "p:1" });
  expect(owner.views()).toHaveLength(2);
  expect(owner.view().path).toBeNull();
  expect(owner.view("first").path).toBe("paper.pdf");
  expect(owner.view("second").path).toBe("report.docx");
  owner.releaseView("second");
  expect(owner.view().path).toBe("paper.pdf");
  owner.close();
  expect(owner.views()).toEqual([]);
});

it("a report finishing after release cannot resurrect a closed viewer", async () => {
  const files = createWorkspaceFiles(resolve(import.meta.dirname, "../../fixtures"));
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const owner = createDocumentOwner({
    files: {
      ...files,
      resolve: async (input) => {
        await gate;
        return files.resolve(input);
      },
    },
    parse: async () => {
      throw new Error("not needed");
    },
  }).session();
  const pending = owner.report({ viewId: "closed", path: "paper.pdf" });
  owner.releaseView("closed");
  release();
  await pending;
  expect(owner.views()).toEqual([]);
});

it("only the newest admitted report commits and reports never retarget the model surface", async () => {
  const files = createWorkspaceFiles(resolve(import.meta.dirname, "../../fixtures"));
  let unblock!: () => void;
  const first = new Promise<void>((done) => {
    unblock = done;
  });
  let calls = 0;
  const owner = createDocumentOwner({
    files: {
      ...files,
      resolve: async (input) => {
        if (++calls === 1) await first;
        return files.resolve(input);
      },
    },
    parse: async () => {
      throw new Error("not needed");
    },
  }).session();
  const old = owner.report({ viewId: "same", path: "paper.pdf", at: "page:1" });
  await owner.report({ viewId: "same", path: "report.docx", at: "p:2" });
  unblock();
  await old;
  expect(owner.view("same").path).toBe("report.docx");
  expect(owner.current()).toBeNull();
  owner.close();
  expect(owner.views()).toEqual([]);
});
