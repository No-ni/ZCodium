import { execFileSync } from "node:child_process";
import { mkdir, open, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProjectTestFixture } from "../../../../../../scripts/ci/project-test-sandbox.mjs";
import { MAX_FILE_BYTES, OfficeError } from "#office/contract.ts";
import * as contract from "#office/contract.ts";
import * as assets from "#office/adapters/assets.ts";
import * as files from "#office/adapters/files.ts";

// 项目内 fresh 合成样本：不写系统临时目录，不做整根递归清理（Office spec §9.5）。
async function fixture() {
  const root = await createProjectTestFixture("office-security");
  const ui = join(root, "ui");
  await mkdir(ui);
  await writeFile(join(ui, "panel.html"), '<div id="root"></div>');
  await writeFile(join(ui, "bundle-0.txt"), "fixture script");
  return { root, ui };
}

// 沙箱 NODE_OPTIONS 下 Node 的 fs.symlink 需要完整非通配读写授权而被拒；这里只在自己的
// fixture 目录里创建链接，回退到平台原生创建方式（Windows junction，POSIX symlink），不写目标。
async function fixtureLink(target: string, linkPath: string) {
  try {
    await symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (
      (error as { code?: string }).code !== "ERR_ACCESS_DENIED" &&
      (error as { code?: string }).code !== "EPERM"
    )
      throw error;
    if (process.platform === "win32")
      execFileSync(
        process.env.ComSpec ?? "cmd.exe",
        ["/d", "/c", "mklink", "/J", linkPath, target],
        { stdio: "ignore", windowsHide: true },
      );
    else execFileSync("ln", ["-s", target, linkPath], { stdio: "ignore" });
  }
}

describe("read-only Office resource boundary", () => {
  it("has no workspace importer or write capability", () => {
    expect("createDocumentImporter" in files).toBe(false);
  });

  it("uses realpath for the panel and whitelisted assets", async () => {
    const { ui } = await fixture();
    expect(assets).toHaveProperty("createOfficeAssets");
    const reader = (
      assets as unknown as {
        createOfficeAssets(root: string): { read(name: string): Promise<{ text?: string }> };
      }
    ).createOfficeAssets(ui);
    expect((await reader.read("panel.html")).text).toContain("root");
    expect((await reader.read("bundle-0.txt")).text).toBe("fixture script");
    for (const name of [
      "../server.mjs",
      "..%2Fserver.mjs",
      "bundle-0.txt%00",
      "https://example.invalid/x",
    ])
      await expect(reader.read(name)).rejects.toMatchObject({ code: "invalid_resource" });
  });

  it("rejects a symlink/junction asset even when its relative name is allowed", async () => {
    const { root, ui } = await fixture();
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "secret.woff2"), "fixture-only secret");
    await fixtureLink(outside, join(ui, "fonts"));
    const reader = (
      assets as unknown as {
        createOfficeAssets(root: string): { read(name: string): Promise<unknown> };
      }
    ).createOfficeAssets(ui);
    await expect(reader.read("fonts/secret.woff2")).rejects.toMatchObject({
      code: "invalid_resource",
    });
  });

  it("rejects over-budget resources before returning bytes", async () => {
    const { ui } = await fixture();
    const handle = await open(join(ui, "oversize.txt"), "w");
    await handle.truncate(8 * 1024 * 1024 + 1);
    await handle.close();
    const reader = (
      assets as unknown as {
        createOfficeAssets(root: string): { read(name: string): Promise<unknown> };
      }
    ).createOfficeAssets(ui);
    await expect(reader.read("oversize.txt")).rejects.toMatchObject({ code: "invalid_resource" });
  });

  it("preserves workspace lexical and realpath containment and file size checks", async () => {
    const { root } = await fixture();
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    await mkdir(workspace);
    await mkdir(outside);
    await writeFile(join(outside, "escape.pdf"), "fixture");
    await fixtureLink(outside, join(workspace, "link"));
    const reader = files.createWorkspaceFiles(workspace);
    await mkdir(join(workspace, "directory.pdf"));
    await expect(reader.load("directory.pdf")).rejects.toMatchObject({ code: "not_found" });
    await expect(reader.resolve("../outside/escape.pdf")).rejects.toMatchObject({
      code: "path_outside_workspace",
    });
    await expect(reader.resolve("link/escape.pdf")).rejects.toMatchObject({
      code: "path_outside_workspace",
    });
    const large = await open(join(workspace, "large.pdf"), "w");
    await large.truncate(MAX_FILE_BYTES + 1);
    await large.close();
    await expect(reader.load("large.pdf")).rejects.toMatchObject({ code: "file_too_large" });
  });

  it("maps raw parser/IO errors to safe codes without raw paths or content", () => {
    expect(contract).toHaveProperty("safeOfficeError");
    const safe = (
      contract as unknown as {
        safeOfficeError(error: unknown): { code: string; message: string };
      }
    ).safeOfficeError;
    const result = safe(new Error("fixture-private-path fixture-private-document"));
    expect(result.code).toBe("corrupt_file");
    expect(result.message).not.toContain("fixture-private");
    expect(safe(new OfficeError("not_found", "fixture-private-path")).message).not.toContain(
      "fixture-private",
    );
  });
});
