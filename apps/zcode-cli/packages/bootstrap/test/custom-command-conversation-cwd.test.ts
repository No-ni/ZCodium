import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { resolveZCodeCustomCommandPrompt } from "../src/custom-command-prompt.js";

it("discovers a workspace command and hands shell execution to the normal runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcodium-command-cwd-"));
  try {
    const cwd = join(root, "2026-10-13", "aaaaaaaa", "current");
    await mkdir(cwd, { recursive: true });
    await mkdir(join(root, ".zcodium", "commands"), { recursive: true });
    const script =
      "require('node:fs').writeFileSync('report.txt','report');process.stdout.write(process.cwd())";
    await writeFile(
      join(root, ".zcodium", "commands", "make-report.md"),
      `!\`"${process.execPath}" -e "${script}"\``,
    );
    const prompt = await resolveZCodeCustomCommandPrompt("/make-report", {
      workingDirectory: root,
      homeDirectory: join(root, "empty-home"),
      skipUserConfig: true,
    });
    assert.ok(prompt?.includes("```bash\n"));
    assert.ok(prompt?.includes(script));
    await assert.rejects(readFile(join(cwd, "report.txt")), { code: "ENOENT" });
    await assert.rejects(readFile(join(root, "report.txt")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
