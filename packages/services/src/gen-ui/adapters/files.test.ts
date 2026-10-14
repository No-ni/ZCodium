import { mkdtemp, mkdir, readdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getGenUiOutputDirectory } from "@zcode/shared/node";
import { readGenUiDocument } from "./files.js";
import { createGenUiService } from "./service.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(workspaceIdentity?: string) {
  const root = await mkdtemp(join(tmpdir(), "zcode-gen-ui-"));
  roots.push(root);
  const workspacePath = join(root, "workspace"),
    outputRoot = join(root, "user-data", "visualizations");
  const scope = { workspacePath, workspaceIdentity, sessionId: "test" };
  const directory = getGenUiOutputDirectory(outputRoot, scope);
  await mkdir(workspacePath);
  await mkdir(directory, { recursive: true });
  return {
    root,
    workspacePath,
    outputRoot,
    directory,
    target: { ...scope, path: join(directory, "chart.html") },
  };
}

describe("Gen UI executor file reader", () => {
  it("reads conversation output using the CLI-owned directory and rejects sibling sessions and links", async () => {
    const { root, workspacePath, outputRoot, target: oldTarget } = await fixture();
    const directory = join(workspacePath, "2026-10-13", "a1b2c3d4", "visualizations");
    const sibling = join(workspacePath, "2026-10-13", "abcd1234", "visualizations");
    await mkdir(directory, { recursive: true });
    await mkdir(sibling, { recursive: true });
    const path = join(directory, "chart.html");
    const otherPath = join(sibling, "chart.html");
    await writeFile(path, "<div>Session-owned</div>");
    await writeFile(otherPath, "<div>Other</div>");
    const queried: string[] = [];
    const service = createGenUiService({
      outputRoot,
      stateRoot: join(root, "state"),
      conversationOutput: {
        conversationWorkspaceRoot: workspacePath,
        resolveSessionWorkspacePath: async (scope) => {
          queried.push(scope.sessionId);
          return scope.sessionId === "test" ? join(directory, "..") : join(sibling, "..");
        },
      },
    });
    const target = { ...oldTarget, path };
    try {
      expect((await service.readDocument(target)).html).toContain("Session-owned");
      expect(queried).toEqual(["test"]);
      await expect(service.readDocument({ ...target, sessionId: "other" })).rejects.toThrow(
        "session output",
      );
      await expect(service.readDocument({ ...target, path: otherPath })).rejects.toThrow(
        "session output",
      );
      await writeFile(oldTarget.path, "<div>Legacy</div>");
      expect((await service.readDocument(oldTarget)).html).toContain("Legacy");
      await rm(directory, { recursive: true });
      await symlink(sibling, directory, "junction");
      await expect(service.readDocument(target)).rejects.toThrow("symbolic links");
      await rm(directory);
      await rm(join(directory, ".."), { recursive: true });
      await symlink(join(sibling, ".."), join(directory, ".."), "junction");
      await expect(service.readDocument(target)).rejects.toThrow("symbolic links");
    } finally {
      service.dispose();
    }
  });
  it.each([undefined, "ssh:executor:/workspace"])(
    "reads the session output without writing into Git (%s)",
    async (identity) => {
      const { outputRoot, target } = await fixture(identity);
      await writeFile(target.path, '<div id="chart">Hello</div>');
      expect((await readGenUiDocument(target, outputRoot)).html).toContain("Hello");
      expect(await readdir(target.workspacePath)).toEqual([]);
      await expect(
        readGenUiDocument({ ...target, sessionId: "other" }, outputRoot),
      ).rejects.toThrow("session output");
      await expect(
        readGenUiDocument({ ...target, workspaceIdentity: "ssh:other:/workspace" }, outputRoot),
      ).rejects.toThrow("session output");
    },
  );
  it("rejects old workspace paths and symbolic links, including the session directory", async () => {
    const { outputRoot, target, directory } = await fixture();
    const oldPath = join(target.workspacePath, "chart.html");
    await writeFile(oldPath, "outside");
    await expect(readGenUiDocument({ ...target, path: oldPath }, outputRoot)).rejects.toThrow(
      "session output",
    );
    await symlink(oldPath, target.path);
    await expect(readGenUiDocument(target, outputRoot)).rejects.toThrow("symbolic links");
    await rm(directory, { recursive: true });
    await symlink(target.workspacePath, directory, "junction");
    await expect(readGenUiDocument(target, outputRoot)).rejects.toThrow("symbolic links");
  });
  it("rejects an output root redirected into the repository", async () => {
    const { root, target } = await fixture();
    const outputRoot = join(root, "redirected");
    await symlink(target.workspacePath, outputRoot, "junction");
    const path = join(
      getGenUiOutputDirectory(outputRoot, {
        workspacePath: target.workspacePath,
        sessionId: target.sessionId,
      }),
      "chart.html",
    );
    await expect(readGenUiDocument({ ...target, path }, outputRoot)).rejects.toThrow(
      "outside the workspace",
    );
  });
  it("rejects whole documents and files above the byte limit", async () => {
    const { outputRoot, target } = await fixture();
    await writeFile(target.path, "<!doctype html><html><body>not a fragment</body></html>");
    await expect(readGenUiDocument(target, outputRoot)).rejects.toThrow("fragment");
    await writeFile(target.path, "x".repeat(5_000_001));
    await expect(readGenUiDocument(target, outputRoot)).rejects.toThrow("5 MB");
  });
});
