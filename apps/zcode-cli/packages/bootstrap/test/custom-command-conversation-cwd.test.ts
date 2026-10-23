import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
    // Node process.cwd 返回 Windows 真实大小写；临时目录 TEMP/Temp 的词法差异不代表 cwd 错误。
    assert.ok(prompt?.includes(await realpath(cwd)));
    assert.equal(await readFile(join(cwd, "report.txt"), "utf8"), "report");
    await assert.rejects(readFile(join(root, "report.txt")), { code: "ENOENT" });
  } finally {
    await executionPort.close?.();
    await rm(root, { recursive: true, force: true });
  }
});
