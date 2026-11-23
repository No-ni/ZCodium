import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createNodeClipboardImageReader } from "../src/clipboard-image.js";

test("image clipboard reader uses the ZCode storage root for native temp files", async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "zcode-clipboard-storage-root-"));
  const imagePaths: string[] = [];
  const readClipboardImage = createNodeClipboardImageReader({
    platform: "darwin",
    processEnv: {
      ...process.env,
      ZCODE_STORAGE_DIR: storageRoot,
    },
    runCommand: async (_file, args) => {
      const scriptLine = args.find((arg) => arg.includes("clipboard.png")) ?? "";
      const match = scriptLine.match(/POSIX file "([^"]+)"/);
      // mock 还原 AppleScript 字符串转义，双反斜线属于脚本文本而非真实文件路径。
      const imagePath = match?.[1] ? JSON.parse(`"${match[1]}"`) as string : undefined;
      if (!imagePath) {
        return { exitCode: 1, stdout: Buffer.alloc(0) };
      }
      imagePaths.push(imagePath);
      await writeFile(imagePath, Buffer.from("png-data"));
      return { exitCode: 0, stdout: Buffer.alloc(0) };
    },
  });

  try {
    const image = await readClipboardImage();
    assert.equal(image?.mediaType, "image/png");
    assert.match(
      (imagePaths[0] ?? "").replaceAll("\\", "/"),
      new RegExp(`^${escapeRegExp(join(storageRoot, "clipboard", "zcode-clipboard-").replaceAll("\\", "/"))}`),
    );
    assert.deepEqual(await readdir(join(storageRoot, "clipboard")), []);
  } finally {
    await rm(storageRoot, { force: true, recursive: true });
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}
