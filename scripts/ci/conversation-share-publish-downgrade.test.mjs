import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildShareTurnRows,
  createShareService,
  readArchiveArtifactTexts,
} from "./fixtures/conversation-share-service.mjs";

// 会话目录里指向工作区之外的符号链接：候选构建只做词法判定（引用本身就在会话目录里），
// 只有 artifactSource 的 realpath 边界能发现。发布侧必须在**读取之前**把它降级成逐条 warning
// （文件没有被读取，安全边界不放松），与预检同粒度；这条降级分支依赖服务与 artifactSource 同图
// （跨图 instanceof 失配时错误会直接抛出、整次发布失败）。

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zcodium-publish-downgrade-"));
  const workspacePath = join(root, "workspace");
  const sessionPath = join(workspacePath, "2026-10-11", "a1b2c3d4");
  await mkdir(join(sessionPath, "docs"), { recursive: true });
  return { root, workspacePath, sessionPath };
}

test("an out-of-workspace candidate is skipped with a warning instead of failing the publish", async () => {
  const { root, workspacePath, sessionPath } = await fixture();
  try {
    // 会话目录里的符号链接指向工作区之外：候选构建只做词法判定（引用本身就在会话目录里），
    // 只有 artifactSource 的 realpath 边界能发现，因此它正好落在发布侧
    // 「读取前的存在性确认」catch 上——那里把 artifact_outside_workspace 降级成逐条 warning
    // （文件**没有被读取**，边界没有被放松）。这条降级分支依赖服务与 artifactSource 同图：
    // 跨图时 instanceof 失配，错误会直接抛出、整次发布失败（本用例即因此由红转绿）。
    const outsideDirectory = join(root, "outside");
    await mkdir(outsideDirectory, { recursive: true });
    const outsidePath = join(outsideDirectory, "secret.pdf");
    await writeFile(outsidePath, Buffer.from("%PDF outside copy"));
    await symlink(outsidePath, join(sessionPath, "escape.pdf"));
    await writeFile(join(sessionPath, "docs", "report.pdf"), Buffer.from("%PDF session copy"));

    const rows = buildShareTurnRows({
      text: ':zcode-file-citation{path="escape.pdf"} :zcode-file-citation{path="docs/report.pdf"}',
    });
    const service = createShareService({ conversationWorkspaceRoot: workspacePath, rows });
    const input = {
      workspacePath,
      sessionId: "session",
      title: "Reports",
      selection: { kind: "productTurns", productTurnIds: ["private-product"] },
    };
    // 预检对同一形状只给非阻断（deferred）提示，所以发布侧必须同粒度：
    // 不能在选择阶段说「可以发」，到发布才整次失败。
    const preflight = await service.preflight({ ...input, fileReferenceRootPath: sessionPath });
    assert.deepEqual(preflight.blockingIssues, []);

    const warnings = [];
    const subscription = service.onDynamicPublishProgress("escape-candidate")((progress) => {
      if (progress.warnings) warnings.push(...progress.warnings);
    });
    const archive = await service.publish(
      { ...input, clientRequestId: "escape-candidate", fileReferenceRootPath: sessionPath },
      "escape-candidate",
    );
    subscription.dispose?.();
    assert.deepEqual(
      warnings.map((warning) => [warning.code, warning.artifactDisplayName, warning.availability]),
      [["artifact_read_failed", "escape.pdf", "unknown"]],
    );
    assert.deepEqual(await readArchiveArtifactTexts(service, archive), ["%PDF session copy"]);
    await service.releaseExport(archive.archiveId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
