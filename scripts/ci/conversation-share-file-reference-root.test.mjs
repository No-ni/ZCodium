import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tsImport } from "tsx/esm/api";
// 本地 artifactSource 从集成夹具取（与 ConversationShareService 同一次 tsImport 的模块图，
// 见 fixtures/conversation-share-service.mjs 的装载判据）。
import { createLocalConversationShareArtifactSource } from "./fixtures/conversation-share-service.mjs";

const { buildConversationPreviewArtifactCandidates, extractConversationPreviewFileReferences } =
  await tsImport("../../packages/shared/src/conversation-preview-artifacts.ts", import.meta.url);

// 会话执行目录与工作区身份根分离（spec: conversation-session-workspace）：
// `fileReferenceRootPath` = 会话执行 cwd（模型写相对路径的基准），workspacePath 仍是安全边界。
// 本文件只覆盖「解析」这一层（引用解析根、候选构建边界、本地 source 的 realpath 边界）；
// 需要真实 ConversationShareService 的发布/预检用例在 conversation-share-publish-*.test.mjs。

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zcodium-refroot-"));
  const workspacePath = join(root, "workspace");
  const sessionPath = join(workspacePath, "2026-10-11", "a1b2c3d4");
  await mkdir(join(sessionPath, "docs"), { recursive: true });
  return { root, workspacePath, sessionPath };
}

test("relative preview references resolve against the file reference root, not the workspace identity", async () => {
  const { root, workspacePath, sessionPath } = await fixture();
  try {
    await writeFile(join(sessionPath, "docs", "report.md"), "# session report");
    await writeFile(join(sessionPath, "docs", "summary.pdf"), "%PDF session");
    const assistantText =
      '见 [报告](docs/report.md) 与 `:zcode-file-citation{path="docs/summary.pdf"}`。';

    const references = extractConversationPreviewFileReferences(assistantText, sessionPath);
    assert.deepEqual(
      references.map((reference) => reference.path).sort(),
      [join(sessionPath, "docs", "report.md"), join(sessionPath, "docs", "summary.pdf")].sort(),
    );

    // markdown 引用需要同轮文件变更佐证；fileChanges[].path 是模型写下的相对路径
    // （CLI 的 checkpoint artifact 直接取工具输出 filePath），必须与正文共用一个解析根。
    const candidates = buildConversationPreviewArtifactCandidates({
      assistantText,
      productTurnId: "turn-1",
      workspacePath,
      fileReferenceRootPath: sessionPath,
      fileChanges: [{ path: "docs/report.md", state: "active" }],
    });
    assert.deepEqual(
      candidates.map((candidate) => candidate.sourceRef).sort(),
      [join(sessionPath, "docs", "report.md"), join(sessionPath, "docs", "summary.pdf")].sort(),
    );

    // 缺省回落 workspacePath：旧行为逐字不变（同一段正文解析到工作区根下的同名路径）。
    const legacyReferences = extractConversationPreviewFileReferences(assistantText, workspacePath);
    assert.deepEqual(
      legacyReferences.map((reference) => reference.path).sort(),
      [join(workspacePath, "docs", "report.md"), join(workspacePath, "docs", "summary.pdf")].sort(),
    );
    const legacyCandidates = buildConversationPreviewArtifactCandidates({
      assistantText,
      productTurnId: "turn-1",
      workspacePath,
      fileChanges: [{ path: "docs/report.md", state: "active" }],
    });
    assert.deepEqual(
      legacyCandidates.map((candidate) => candidate.sourceRef).sort(),
      [join(workspacePath, "docs", "report.md"), join(workspacePath, "docs", "summary.pdf")].sort(),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the workspace boundary still uses the workspace identity when a file reference root is given", async () => {
  const { root, workspacePath, sessionPath } = await fixture();
  try {
    // 前导 `..` 不再在词法层被拒：解析根是会话执行目录（严格在工作区**之内**一层），
    // `../x.pdf` 就是模型引用相邻目录的正常写法（改动前解析根等于工作区根，chroot 恰好等价于
    // 安全边界，所以那时拒掉是对的）。解析层只给词法归一化后的绝对路径，越界交给边界判。
    assert.deepEqual(
      extractConversationPreviewFileReferences(
        ':zcode-file-citation{path="../../../outside.pdf"}',
        sessionPath,
      ).map((reference) => reference.path),
      [join(root, "outside.pdf")],
    );
    // 越界引用在候选层被 isInsideWorkspace 拒掉——这是唯一的安全边界。
    assert.deepEqual(
      buildConversationPreviewArtifactCandidates({
        assistantText: ':zcode-file-citation{path="../../../outside.pdf"}',
        fileReferenceRootPath: sessionPath,
        productTurnId: "turn-1",
        workspacePath,
      }),
      [],
    );
    // 上溯但仍在工作区内（`../sibling.pdf` = <workspace>/<日期>/sibling.pdf）⇒ 候选照常产出：
    // 这是「解析根比边界深一层」带来的新能力，过去这条引用会被 chroot 静默丢掉。
    await writeFile(join(workspacePath, "2026-10-11", "sibling.pdf"), "%PDF sibling");
    assert.deepEqual(
      buildConversationPreviewArtifactCandidates({
        assistantText: ':zcode-file-citation{path="../sibling.pdf"}',
        fileReferenceRootPath: sessionPath,
        productTurnId: "turn-1",
        workspacePath,
      }).map((candidate) => candidate.sourceRef),
      [join(workspacePath, "2026-10-11", "sibling.pdf")],
    );

    // 解析根在工作区之外时，相对引用解析出的路径也必须被 isInsideWorkspace(workspacePath) 排除：
    // 边界读的是工作区身份，不是解析根。
    const outsideRoot = join(root, "elsewhere");
    await mkdir(join(outsideRoot, "docs"), { recursive: true });
    await writeFile(join(outsideRoot, "docs", "report.pdf"), "%PDF outside");
    const outsideRootText = "[报告](docs/report.pdf)";
    assert.deepEqual(
      extractConversationPreviewFileReferences(outsideRootText, outsideRoot).map(
        (reference) => reference.path,
      ),
      [join(outsideRoot, "docs", "report.pdf")],
    );
    assert.deepEqual(
      buildConversationPreviewArtifactCandidates({
        assistantText: outsideRootText,
        productTurnId: "turn-1",
        workspacePath,
        fileReferenceRootPath: outsideRoot,
      }),
      [],
    );

    // 绝对引用落在工作区根上（导入分享安装的 `.zcodium-share/...` 就在这里）时不能被误判出界：
    // 边界必须读 workspacePath，不能读会话执行目录。
    const installedPath = join(
      workspacePath,
      ".zcodium-share",
      "archive-x",
      "shared-artifacts",
      "file-1-x.pdf",
    );
    const installedText = `:zcode-file-citation{path="${installedPath}"}`;
    assert.deepEqual(
      buildConversationPreviewArtifactCandidates({
        assistantText: installedText,
        productTurnId: "turn-1",
        workspacePath,
        fileReferenceRootPath: sessionPath,
      }).map((candidate) => candidate.sourceRef),
      [installedPath],
    );

    // 工作区之外的绝对引用同样被拒（安全性质不因新增解析根而放松）。
    const outsidePath = join(root, "outside.pdf");
    assert.deepEqual(
      buildConversationPreviewArtifactCandidates({
        assistantText: `:zcode-file-citation{path="${outsidePath}"}`,
        productTurnId: "turn-1",
        workspacePath,
        fileReferenceRootPath: sessionPath,
      }),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local artifact source reads relative refs from the file reference root and keeps the workspace boundary", async () => {
  const { root, workspacePath, sessionPath } = await fixture();
  try {
    await writeFile(join(sessionPath, "docs.txt"), "session file");
    await writeFile(join(workspacePath, "root.txt"), "workspace file");
    await writeFile(join(root, "outside.txt"), "outside file");
    await writeFile(join(root, "outside-link-target.txt"), "symlinked outside file");
    await symlink(join(root, "outside-link-target.txt"), join(sessionPath, "link-outside.txt"));
    const source = createLocalConversationShareArtifactSource();
    const sessionRef = { workspacePath, fileReferenceRootPath: sessionPath, ref: "docs.txt" };

    const read = await source.read({ ...sessionRef, maxBytes: 1024 });
    assert.equal(Buffer.from(read.bytes).toString(), "session file");
    assert.equal(read.canonicalPath, await realpath(join(sessionPath, "docs.txt")));
    const stat = await source.stat({
      workspacePath,
      fileReferenceRootPath: sessionPath,
      ref: "docs.txt",
    });
    assert.equal(stat.size, "session file".length);

    // 缺省行为不变：不给解析根时相对引用仍按 workspacePath 解析（工作区根没有该文件 → 可跳过读失败）。
    await assert.rejects(
      () => source.read({ workspacePath, ref: "docs.txt", maxBytes: 1024 }),
      (error) =>
        error.kind === "invalid_conversation" && error.reasonCode === "artifact_read_failed",
    );

    // 解析根在工作区内，但引用逃逸到工作区之外 → 仍被拒（realpath 之后再判包含）。
    for (const ref of ["../../../outside.txt", "link-outside.txt"]) {
      await assert.rejects(
        () =>
          source.read({ workspacePath, fileReferenceRootPath: sessionPath, ref, maxBytes: 1024 }),
        (error) => error.kind === "unsafe_structure",
      );
      await assert.rejects(
        () => source.stat({ workspacePath, fileReferenceRootPath: sessionPath, ref }),
        (error) => error.kind === "unsafe_structure",
      );
    }

    // 绝对引用不受解析根影响：工作区根上的文件在给了会话解析根后仍可读。
    const absolute = await source.read({
      workspacePath,
      fileReferenceRootPath: sessionPath,
      ref: join(workspacePath, "root.txt"),
      maxBytes: 1024,
    });
    assert.equal(Buffer.from(absolute.bytes).toString(), "workspace file");
    assert.equal(
      (
        await source.stat({
          workspacePath,
          fileReferenceRootPath: sessionPath,
          ref: join(workspacePath, "root.txt"),
        })
      ).size,
      "workspace file".length,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
