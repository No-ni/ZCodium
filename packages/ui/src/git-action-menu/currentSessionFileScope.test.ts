import { describe, expect, it } from "vitest";
import type { GitRepositorySummary, ZCodeTaskChangeSummary } from "@zcode/shared";
import {
  filterCommitPreviewFilesByCurrentSession,
  getCurrentSessionFilePaths,
} from "@/git-action-menu/currentSessionFileScope.js";
import type { GitBranchCommitPreviewFile } from "@/git-branch-switcher/display.js";

// 提交弹窗的「当前会话文件范围」（见 docs/specs/conversation-session-workspace.md 规则 11）：
// `activeTaskChangeSummary.files[].path` 是**模型原文**，可能是相对会话执行 cwd 的相对路径；
// 而 git 侧候选拼写是工作区键路径相对（`<日期>/<id8>/docs/report.md`）。不解析原文时两条
// `stripBasePath` 分支都落空，这次会话写下的变更会被整条过滤掉（列表空白、提交不了任何文件）。
const CONVERSATION_ROOT = "/Users/me/.zcodium/workspace/default";
const SESSION_DIR = `${CONVERSATION_ROOT}/2026-10-11/a1b2c3d4`;
const REPO_RELATIVE = "2026-10-11/a1b2c3d4/docs/report.md";

function createSummary(): ZCodeTaskChangeSummary {
  return {
    files: [{ path: "docs/report.md" } as ZCodeTaskChangeSummary["files"][number]],
  } as ZCodeTaskChangeSummary;
}

function createGitSummary(): GitRepositorySummary {
  return {
    branchName: "main",
    repoRoot: CONVERSATION_ROOT,
    workspaceInRepoPath: ".",
  } as GitRepositorySummary;
}

function createPreviewFile(): GitBranchCommitPreviewFile {
  return {
    stagePath: REPO_RELATIVE,
    repoRelativePath: REPO_RELATIVE,
    workspaceRelativePath: REPO_RELATIVE,
    kind: "modified",
    added: 1,
    removed: 0,
  };
}

describe("getCurrentSessionFilePaths", () => {
  it("模型原文的相对路径按解析根拼成绝对路径（服务侧拿不到会话根）", () => {
    expect(getCurrentSessionFilePaths(createSummary(), SESSION_DIR)).toEqual([
      `${SESSION_DIR}/docs/report.md`,
    ]);
  });

  it("绝对路径原样返回；缺席解析根 = 改动前行为", () => {
    const absolute = {
      files: [{ path: `${SESSION_DIR}/docs/report.md` }],
    } as ZCodeTaskChangeSummary;
    expect(getCurrentSessionFilePaths(absolute, SESSION_DIR)).toEqual([
      `${SESSION_DIR}/docs/report.md`,
    ]);
    expect(getCurrentSessionFilePaths(createSummary())).toEqual(["docs/report.md"]);
  });
});

describe("filterCommitPreviewFilesByCurrentSession", () => {
  it("相对路径写出的变更在会话 cwd 下被保留（修复前是 0 条）", () => {
    const kept = filterCommitPreviewFilesByCurrentSession({
      files: [createPreviewFile()],
      summary: createSummary(),
      gitSummary: createGitSummary(),
      workspacePath: CONVERSATION_ROOT,
      fileReferenceRootPath: SESSION_DIR,
    });
    expect(kept.map((file) => file.repoRelativePath)).toEqual([REPO_RELATIVE]);

    // 对照：不传解析根（= 改动前行为）时相对原文与 git 拼写对不上，整条被过滤掉。
    const withoutRoot = filterCommitPreviewFilesByCurrentSession({
      files: [createPreviewFile()],
      summary: createSummary(),
      gitSummary: createGitSummary(),
      workspacePath: CONVERSATION_ROOT,
    });
    expect(withoutRoot).toEqual([]);
  });
});
