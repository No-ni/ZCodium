import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createNodeExecutionAdapter } from "../../adapters/src/exec/index.js";
import { resolveZCodeCustomCommandPrompt } from "../src/custom-command-prompt.js";

it("discovers a workspace slash command but executes its shell expansion in the session cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcodium-command-cwd-"));
  const executionPort = createNodeExecutionAdapter();
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
      executionWorkingDirectory: cwd,
      homeDirectory: join(root, "empty-home"),
      skipUserConfig: true,
      executionPort,
    });
    assert.ok(prompt?.includes(cwd));
    assert.equal(await readFile(join(cwd, "report.txt"), "utf8"), "report");
    await assert.rejects(readFile(join(root, "report.txt")), { code: "ENOENT" });
  } finally {
    await executionPort.close?.();
    await rm(root, { recursive: true, force: true });
  }
});
