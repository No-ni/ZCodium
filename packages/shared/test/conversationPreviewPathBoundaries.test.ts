import assert from "node:assert/strict";
import test from "node:test";
import {
  buildConversationPreviewArtifactCandidates,
  extractConversationPreviewFileReferences,
  resolveConversationPreviewPath,
} from "../src/conversation-preview-artifacts.js";

interface PathCase {
  name: string;
  workspace: string;
  raw: string;
  expected: string;
  cwd?: string;
}

// 只使用虚构路径和实际导出；不读取文件、连接远端或访问用户目录。
function assistantText(raw: string): string {
  return raw.startsWith("file://") ? raw : '::zcode-file-citation{path="' + raw + '"}';
}

const accepted: PathCase[] = [
  {
    name: "Windows URL 解码井号",
    workspace: "C:/workspace",
    raw: "file:///C:/workspace/report%23v1.pdf",
    expected: "C:/workspace/report#v1.pdf",
  },
  {
    name: "POSIX URL 解码井号",
    workspace: "/workspace",
    raw: "file:///workspace/report%23v1.pdf",
    expected: "/workspace/report#v1.pdf",
  },
  {
    name: "URL 解码保留的文件名字符",
    workspace: "/workspace",
    raw: "file:///workspace/report%3Fv1%26copy%3D2.pdf",
    expected: "/workspace/report?v1&copy=2.pdf",
  },
  {
    name: "URL 空格对照",
    workspace: "/workspace",
    raw: "file:///workspace/report%20v1.pdf",
    expected: "/workspace/report v1.pdf",
  },
  {
    name: "URL Unicode 对照",
    workspace: "/workspace",
    raw: "file:///workspace/%E6%8A%A5%E5%91%8A.pdf",
    expected: "/workspace/报告.pdf",
  },
  {
    name: "URL 双重编码只解码一次",
    workspace: "/workspace",
    raw: "file:///workspace/report%2523v1.pdf",
    expected: "/workspace/report%23v1.pdf",
  },
  {
    name: "普通路径中的百分号井号保持字面值",
    workspace: "/workspace",
    raw: "report%23v1.pdf",
    expected: "/workspace/report%23v1.pdf",
  },
  {
    name: "普通路径中的百分号空格保持字面值",
    workspace: "/workspace",
    raw: "report%20v1.pdf",
    expected: "/workspace/report%20v1.pdf",
  },
  {
    name: "UNC URL 保留命名空间",
    workspace: "//fileserver/share/project",
    raw: "file://fileserver/share/project/report.pdf",
    expected: "//fileserver/share/project/report.pdf",
  },
  {
    name: "UNC 正斜线保留命名空间",
    workspace: "//fileserver/share/project",
    raw: "//fileserver/share/project/report.pdf",
    expected: "//fileserver/share/project/report.pdf",
  },
  {
    name: "UNC 反斜线保留命名空间",
    workspace: "//fileserver/share/project",
    raw: "\\\\fileserver\\share\\project\\report.pdf",
    expected: "//fileserver/share/project/report.pdf",
  },
  {
    name: "UNC 原始父目录不能弹出 share 根",
    workspace: "//fileserver/share",
    raw: "//fileserver/share/project/../../../report.pdf",
    expected: "//fileserver/share/report.pdf",
  },
  {
    name: "UNC cwd 父目录不能弹出 share 根",
    workspace: "//fileserver/share",
    cwd: "//fileserver/share/project/nested",
    raw: "../../../report.pdf",
    expected: "//fileserver/share/report.pdf",
  },
  {
    name: "盘符原始父目录不能弹出盘符根",
    workspace: "C:/",
    raw: "C:/../../../report.pdf",
    expected: "C:/report.pdf",
  },
  {
    name: "盘符 cwd 父目录不能弹出盘符根",
    workspace: "C:/",
    cwd: "C:/project/nested",
    raw: "../../../report.pdf",
    expected: "C:/report.pdf",
  },
  {
    name: "POSIX 根内父目录对照",
    workspace: "/",
    cwd: "/workspace/nested",
    raw: "../../../report.pdf",
    expected: "/report.pdf",
  },
  {
    name: "盘符 cwd 合法父目录对照",
    workspace: "C:/workspace",
    cwd: "C:/workspace/nested",
    raw: "../report.pdf",
    expected: "C:/workspace/report.pdf",
  },
  {
    name: "POSIX cwd 合法父目录对照",
    workspace: "/workspace",
    cwd: "/workspace/nested",
    raw: "../report.pdf",
    expected: "/workspace/report.pdf",
  },
  {
    name: "UNC cwd 合法父目录",
    workspace: "//fileserver/share/project",
    cwd: "//fileserver/share/project/nested",
    raw: "../report.pdf",
    expected: "//fileserver/share/project/report.pdf",
  },
];

for (const { name, workspace, cwd = workspace, raw, expected } of accepted) {
  test(name, () => {
    assert.equal(resolveConversationPreviewPath(cwd, raw), expected);
    const text = assistantText(raw);
    const references = extractConversationPreviewFileReferences(text, cwd);
    assert.deepEqual(
      references.map((reference) => reference.path),
      [expected],
    );
    const candidates = buildConversationPreviewArtifactCandidates({
      assistantText: text,
      productTurnId: "turn-preview-boundary",
      workspacePath: workspace,
      fileReferenceRootPath: cwd,
    });
    assert.deepEqual(
      candidates.map((candidate) => candidate.sourceRef),
      [expected],
    );
    assert.equal(candidates[0]?.previewKind, "pdf");
  });
}

for (const separator of ["%2f", "%2F", "%5c", "%5C"]) {
  test("URL 编码分隔符 " + separator + " 不能新增路径段", () => {
    const raw = "file:///workspace/folder" + separator + "report.pdf";
    assert.equal(resolveConversationPreviewPath("/workspace", raw), null);
    assert.deepEqual(extractConversationPreviewFileReferences(raw, "/workspace"), []);
    assert.deepEqual(
      buildConversationPreviewArtifactCandidates({
        assistantText: raw,
        productTurnId: "turn-preview-boundary",
        workspacePath: "/workspace",
      }),
      [],
    );
  });
}

const rejected = [
  {
    name: "UNC 工作区拒绝同名单斜线路径",
    workspace: "//fileserver/share/project",
    raw: "/fileserver/share/project/report.pdf",
  },
  {
    name: "本地根工作区拒绝 UNC citation",
    workspace: "/",
    raw: "\\\\fileserver\\share\\project\\report.pdf",
  },
  {
    name: "不同盘符继续拒绝",
    workspace: "C:/workspace",
    raw: "D:/workspace/report.pdf",
  },
  {
    name: "不同 UNC share 继续拒绝",
    workspace: "//fileserver/share/project",
    raw: "//fileserver/other/project/report.pdf",
  },
  {
    name: "UNC 同名前缀邻居继续拒绝",
    workspace: "//fileserver/share/project",
    raw: "//fileserver/share/project-copy/report.pdf",
  },
  {
    name: "UNC cwd 越工作区父目录继续拒绝",
    workspace: "//fileserver/share/project",
    cwd: "//fileserver/share/project/nested",
    raw: "../../report.pdf",
  },
  {
    name: "盘符 cwd 越工作区父目录继续拒绝",
    workspace: "C:/workspace",
    cwd: "C:/workspace/nested",
    raw: "../../report.pdf",
  },
  {
    name: "POSIX 同名前缀邻居继续拒绝",
    workspace: "/workspace",
    raw: "/workspace-copy/report.pdf",
  },
];

for (const { name, workspace, cwd = workspace, raw } of rejected) {
  test(name, () => {
    assert.deepEqual(
      buildConversationPreviewArtifactCandidates({
        assistantText: assistantText(raw),
        productTurnId: "turn-preview-boundary",
        workspacePath: workspace,
        fileReferenceRootPath: cwd,
      }),
      [],
    );
  });
}

test("父目录归一化仍保留绝对根", () => {
  assert.equal(resolveConversationPreviewPath("C:/", "../"), "C:/");
  assert.equal(resolveConversationPreviewPath("//fileserver/share", "../"), "//fileserver/share");
});

test("远端 file URL 的盘符形 pathname 不能转换为本地路径", () => {
  const raw = "file://fileserver/C:/workspace/report.pdf";
  const expected = "//fileserver/C:/workspace/report.pdf";
  assert.equal(resolveConversationPreviewPath("C:/workspace", raw), expected);
  assert.deepEqual(
    extractConversationPreviewFileReferences(raw, "C:/workspace").map(
      (reference) => reference.path,
    ),
    [expected],
  );
  assert.deepEqual(
    buildConversationPreviewArtifactCandidates({
      assistantText: raw,
      productTurnId: "turn-preview-boundary",
      workspacePath: "C:/workspace",
    }),
    [],
  );
});
