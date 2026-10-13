import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildShareTurnRows,
  createShareService,
  readArchiveArtifactTexts,
  resolveConversationSharePublishErrorMessageId,
} from "./fixtures/conversation-share-service.mjs";

// 预检快照里记着当时的**生效解析根**；发布阶段取到同一快照时根不一致必须显式失败重试。
// 否则发布方会按新根重新解析并放行候选，用户收到与选择阶段卡片同名的另一份文件且无任何提示。
// 这条硬校验必须独立于「水位」（visibleSourceRefs 是否可用）：预检有候选 stat 没能定论时水位
// 不可用，但根一致性不能一起放弃（见 conversation-share-publish-downgrade.test.mjs 的对照）。

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zcodium-publish-root-"));
  const workspacePath = join(root, "workspace");
  const sessionPath = join(workspacePath, "2026-10-11", "a1b2c3d4");
  await mkdir(join(sessionPath, "docs"), { recursive: true });
  return { root, workspacePath, sessionPath };
}

test("publishing fails fast when the reference root changed after preflight", async () => {
  // 预检快照里记着当时的生效解析根；发布阶段取到同一快照时，根不一致必须显式失败。
  // 否则发布侧会按**新的根**重新解析并放行全部候选（preflightMatches 为假 → 不过滤），
  // 用户可能收到与选择阶段卡片不是同一份（同名不同内容）的文件，且没有任何 warning。
  const directory = await mkdtemp(join(tmpdir(), "zcodium-export-root-shift-"));
  const sessionDirectory = join(directory, "2026-10-11", "a1b2c3d4");
  const base = {
    turnId: "private-turn",
    productTurnId: "private-product",
    createdAt: 1,
    createdAtSeq: 1,
  };
  const rows = [
    {
      ...base,
      rowId: 1,
      kind: "turnHeader",
      origin: "userInput",
      state: "completedSuccess",
      startedAt: 1,
    },
    { ...base, rowId: 2, kind: "userInput", origin: "realUser", text: "Share the report" },
    {
      ...base,
      rowId: 3,
      kind: "assistantText",
      state: "complete",
      text: "见 [报告](docs/report.pdf)",
    },
  ];
  try {
    await mkdir(join(sessionDirectory, "docs"), { recursive: true });
    await mkdir(join(directory, "docs"), { recursive: true });
    await writeFile(join(sessionDirectory, "docs", "report.pdf"), Buffer.from("session copy"));
    await writeFile(join(directory, "docs", "report.pdf"), Buffer.from("workspace copy"));
    const service = createShareService({ conversationWorkspaceRoot: directory, rows });
    const input = {
      workspacePath: directory,
      sessionId: "session",
      title: "Report",
      selection: { kind: "productTurns", productTurnIds: ["private-product"] },
    };
    await service.preflight({ ...input, fileReferenceRootPath: sessionDirectory });
    // 根变了（例如切会话首帧的快照尚未到达，UI 回落到 tab 的 workspacePath）→ 必须失败：
    // 选择阶段看到的卡片是按会话目录解析的，按工作区根发布就是另一份文件。
    // reasonCode 必须是 stale_conversation（由消息在 ConversationShareServiceError 构造时判定）：
    // UI 据此提示「会话在准备分享期间发生变化，请返回选择后重试。」；若落回兜底的
    // invalid_conversation，用户看到的是「所选内容包含当前版本暂不支持的结构」——把
    // 「重试即可」误导成「内容本身不支持」。
    await assert.rejects(
      () =>
        service.publish(
          {
            ...input,
            clientRequestId: "root-shifted",
            selection: input.selection,
            fileReferenceRootPath: directory,
          },
          "root-shifted",
        ),
      (error) => {
        assert.match(error.message, /reference root changed/u);
        assert.equal(error.kind, "invalid_conversation");
        assert.equal(error.reasonCode, "stale_conversation");
        assert.equal(
          resolveConversationSharePublishErrorMessageId(error),
          "conversationShare.issue.staleConversation",
        );
        return true;
      },
    );
    // 同一个根仍然能正常发布（失败只针对"根变了"，不是把分享整体打死）。
    const archive = await service.publish(
      {
        ...input,
        clientRequestId: "same-root",
        selection: input.selection,
        fileReferenceRootPath: sessionDirectory,
      },
      "same-root",
    );
    assert.ok(archive.byteLength > 0);
    // 只断言「归档非空」分不出打包了哪一份：同名不同内容的两个文件按工作区根解析会拿到
    // "workspace copy"。这里断言归档正文就是**会话目录**那一份，正是根回落的判别点。
    assert.deepEqual(await readArchiveArtifactTexts(service, archive), ["session copy"]);
    await service.releaseExport(archive.archiveId);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unsettled preflight keeps the reference-root guard instead of dropping the snapshot", async () => {
  // 预检时有候选的 stat 没能定论（会话目录里指向工作区外的符号链接 → artifact_outside_workspace
  // 被降级成 deferred 提示）时，水位（visibleSourceRefs）不可用，但**解析根的一致性不能一起丢**。
  // 删掉快照会让发布阶段既不过滤可见候选、也不做根校验，于是按新根重新解析并分享与卡片同名的
  // 另一份文件（无 warning）——正是根校验要防的事。这里用「同名不同内容」把它钉死。
  const { root, workspacePath, sessionPath } = await fixture();
  try {
    const outsideDirectory = join(root, "outside");
    await mkdir(outsideDirectory, { recursive: true });
    const outsidePath = join(outsideDirectory, "secret.pdf");
    await writeFile(outsidePath, Buffer.from("%PDF outside copy"));
    await symlink(outsidePath, join(sessionPath, "escape.pdf"));
    await writeFile(join(sessionPath, "docs", "report.pdf"), Buffer.from("%PDF session copy"));
    await mkdir(join(workspacePath, "docs"), { recursive: true });
    await writeFile(join(workspacePath, "docs", "report.pdf"), Buffer.from("%PDF workspace copy"));

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
    const preflight = await service.preflight({ ...input, fileReferenceRootPath: sessionPath });
    assert.deepEqual(preflight.blockingIssues, []);
    // 这次预检的水位不可用（有 deferred 候选）——修复前正是这个分支删掉快照。
    assert.ok(preflight.deferredIssues.length > 0);

    // 根变了（例如切会话首帧快照未到，UI 回落到 tab 的 workspacePath）：必须失败重试，
    // 而不是安静地分享出工作区根下的同名文件（"workspace copy"）。
    await assert.rejects(
      () =>
        service.publish(
          {
            ...input,
            clientRequestId: "unsettled-root-shift",
            selection: input.selection,
            fileReferenceRootPath: workspacePath,
          },
          "unsettled-root-shift",
        ),
      (error) => {
        assert.match(error.message, /reference root changed/u);
        assert.equal(error.reasonCode, "stale_conversation");
        return true;
      },
    );

    // 同一个根仍然按「全部候选」确认并正常发布：越界候选只作为 warning 跳过，
    // 真正属于本次选择的文件必须是会话目录里的那一份。
    const warnings = [];
    const subscription = service.onDynamicPublishProgress("unsettled-same-root")((progress) => {
      if (progress.warnings) warnings.push(...progress.warnings);
    });
    const archive = await service.publish(
      {
        ...input,
        clientRequestId: "unsettled-same-root",
        fileReferenceRootPath: sessionPath,
      },
      "unsettled-same-root",
    );
    subscription.dispose?.();
    assert.deepEqual(
      warnings.map((warning) => [warning.code, warning.artifactDisplayName]),
      [["artifact_read_failed", "escape.pdf"]],
    );
    assert.deepEqual(await readArchiveArtifactTexts(service, archive), ["%PDF session copy"]);
    await service.releaseExport(archive.archiveId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
