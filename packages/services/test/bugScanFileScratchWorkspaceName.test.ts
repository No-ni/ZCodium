import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { test } from "node:test";
import { createFileService } from "../src/file/fileService.js";

// 本文件仅在 scripts/ci/source-test-runner.mjs 的沙箱子进程中执行：
// HOME/USERPROFILE 已重定向到 .run-logs/project-only-validation/<sandbox>/home，
// 目录写入被 --permission --allow-fs-write=<sandbox> 约束在沙箱内。
const scratchRoot = join(homedir(), "ZCodeProject");

function isInsideScratchRoot(path: string): boolean {
  const root = resolve(scratchRoot);
  const target = resolve(path);
  return target === root || target.startsWith(root + sep);
}

test("createScratchWorkspace 拒绝 .. 名称逃逸到用户主目录", async () => {
  const service = createFileService();
  await assert.rejects(
    () => service.createScratchWorkspace({ name: ".." }),
    /path separators|relative path segment/,
  );
});

test("createScratchWorkspace 拒绝 . 名称逃逸到 ZCodeProject 根", async () => {
  const service = createFileService();
  await assert.rejects(
    () => service.createScratchWorkspace({ name: "." }),
    /path separators|relative path segment/,
  );
});

test("createScratchWorkspace 继续拒绝含路径分隔符的名称（既有守卫回归位）", async () => {
  const service = createFileService();
  await assert.rejects(() => service.createScratchWorkspace({ name: "a/b" }), /path separators/);
  await assert.rejects(() => service.createScratchWorkspace({ name: "a\\b" }), /path separators/);
  await assert.rejects(() => service.createScratchWorkspace({ name: "   " }), /required/);
});

test("createScratchWorkspace 合法名称创建在 ZCodeProject 根内", async () => {
  const service = createFileService();
  const result = await service.createScratchWorkspace({ name: "demo-scratch" });
  assert.equal(result.path, join(scratchRoot, "demo-scratch"));
  assert.ok(isInsideScratchRoot(result.path));
  const info = await stat(result.path);
  assert.ok(info.isDirectory());
});
