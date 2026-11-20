import { join } from "node:path";
import * as fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { activateDirectoryAtomically } from "../src/plugins/atomic-directory.js";
import { createProjectTestFixture } from "../../../../../scripts/ci/project-test-sandbox.mjs";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
afterEach(() => vi.mocked(fs.rename).mockImplementation(actual.rename));

async function fixture() {
  const root = await createProjectTestFixture("plugin-directory-windows-rename");
  const sourcePath = join(root, "source");
  const targetPath = join(root, "active");
  for (const path of [sourcePath, targetPath]) await fs.mkdir(path);
  await fs.writeFile(join(sourcePath, "value.txt"), "new generation");
  await fs.writeFile(join(targetPath, "value.txt"), "old generation");
  return { root, sourcePath, targetPath };
}

it.runIf(process.platform === "win32")(
  "retries a transient Windows directory rename under the same transaction owner",
  async () => {
    const f = await fixture();
    let attempts = 0;
    vi.mocked(fs.rename).mockImplementation(async (source, target) => {
      if (String(source).endsWith("content") && target === f.targetPath && attempts++ === 0)
        throw Object.assign(new Error("synthetic transient directory lock"), { code: "EPERM" });
      return actual.rename(source, target);
    });
    try {
      const activation = await activateDirectoryAtomically(f);
      expect(attempts).toBe(2);
      await expect(activateDirectoryAtomically(f)).rejects.toThrow(/already active/);
      await activation.rollback();
      expect(await fs.readFile(join(f.targetPath, "value.txt"), "utf8")).toBe("old generation");
      const next = await activateDirectoryAtomically(f);
      await next.finalize();
      expect(await fs.readFile(join(f.targetPath, "value.txt"), "utf8")).toBe("new generation");
    } finally {
      await fs.rm(f.root, { recursive: true, force: true });
    }
  },
);

it.runIf(process.platform === "win32").each([
  { code: "EPERM", attempts: 3 },
  { code: "ENOSPC", attempts: 1 },
])(
  "keeps the old cache after $code and bounds attempts to $attempts",
  async ({ code, attempts }) => {
    const f = await fixture();
    const failure = Object.assign(new Error("synthetic directory failure"), { code });
    let observed = 0;
    vi.mocked(fs.rename).mockImplementation(async (source, target) => {
      if (String(source).endsWith("content") && target === f.targetPath) {
        observed++;
        throw failure;
      }
      return actual.rename(source, target);
    });
    try {
      await expect(activateDirectoryAtomically(f)).rejects.toBe(failure);
      expect(observed).toBe(attempts);
      expect(await fs.readFile(join(f.targetPath, "value.txt"), "utf8")).toBe("old generation");
      expect((await fs.readdir(f.root)).sort()).toEqual(["active", "source"]);
    } finally {
      await fs.rm(f.root, { recursive: true, force: true });
    }
  },
);
