import type { GitRepositorySummary, ZCodeTaskChangeSummary } from "@zcode/shared";
import type { GitBranchCommitPreviewFile } from "@/git-branch-switcher/display.js";
import { resolveToolCallFilePath } from "@/ToolCallBlocks/fileSummaryTypes.js";

function normalizeCommitScopePath(path: string): string {
  return path
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "")
    .replace(/\/+$/, "");
}

function normalizeBasePath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

function normalizeWorkspaceInRepoPath(path: string): string {
  const normalized = normalizeCommitScopePath(path);
  return normalized.length > 0 ? normalized : ".";
}

function stripBasePath(path: string, basePath: string): string | null {
  const normalizedPath = normalizeBasePath(path);
  const normalizedBasePath = normalizeBasePath(basePath);
  if (!normalizedPath || !normalizedBasePath) {
    return null;
  }

  if (normalizedPath === normalizedBasePath) {
    return "";
  }

  const prefix = `${normalizedBasePath}/`;
  if (normalizedPath.startsWith(prefix)) {
    return normalizedPath.slice(prefix.length);
  }

  const lowerPath = normalizedPath.toLowerCase();
  const lowerPrefix = prefix.toLowerCase();
  if (lowerPath.startsWith(lowerPrefix)) {
    return normalizedPath.slice(prefix.length);
  }

  return null;
}

function addScopePath(scope: Set<string>, path: string | null): void {
  if (path === null) {
    return;
  }

  const normalizedPath = normalizeCommitScopePath(path);
  if (normalizedPath) {
    scope.add(normalizedPath);
  }
}

function buildCurrentSessionFileScope(options: {
  summary: ZCodeTaskChangeSummary | null;
  gitSummary: GitRepositorySummary;
  workspacePath: string;
  fileReferenceRootPath?: string | undefined;
}): Set<string> | null {
  const filePaths = getCurrentSessionFilePaths(options.summary, options.fileReferenceRootPath);
  if (!filePaths) {
    return null;
  }

  const scope = new Set<string>();
  const workspaceInRepoPath = normalizeWorkspaceInRepoPath(options.gitSummary.workspaceInRepoPath);

  for (const filePath of filePaths) {
    addScopePath(scope, filePath);
    addScopePath(scope, stripBasePath(filePath, options.gitSummary.repoRoot));
    addScopePath(scope, stripBasePath(filePath, options.workspacePath));

    const normalizedPath = normalizeCommitScopePath(filePath);
    if (workspaceInRepoPath !== "." && !normalizedPath.startsWith(`${workspaceInRepoPath}/`)) {
      addScopePath(scope, `${workspaceInRepoPath}/${normalizedPath}`);
    }
  }

  return scope.size > 0 ? scope : null;
}

function isPreviewFileInScope(
  file: GitBranchCommitPreviewFile,
  scope: Set<string> | null,
): boolean {
  if (!scope) {
    return true;
  }

  return [file.stagePath, file.repoRelativePath, file.workspaceRelativePath].some((path) =>
    scope.has(normalizeCommitScopePath(path)),
  );
}

/**
 * 本会话变更过的文件路径（模型原文），按会话执行 cwd 解析成绝对路径。
 *
 * 为什么要在这里解析：`summary.files[].path` 是**模型写的原文**，可能是相对路径；而 git 侧
 * 的候选拼写是工作区键路径相对（`<日期>/<id8>/docs/report.md`）。原文不解析时相对路径两条
 * `stripBasePath` 分支都落空，提交弹窗会把这次会话写下的变更**整条过滤掉**（列表空白、
 * 「包含未暂存」被置 false），同一份文件用绝对路径写却正常——改动前模型 cwd 恰好是工作区键
 * 路径，原文与 git 拼写逐字相等，所以这是本特性引入的收窄（见
 * docs/specs/conversation-session-workspace.md 规则 11）。
 * `fileReferenceRootPath` 缺席时原样返回 = 改动前行为，调用方负责传
 * `fileReferenceRootPath ?? workspacePath`。
 */
export function getCurrentSessionFilePaths(
  summary: ZCodeTaskChangeSummary | null,
  fileReferenceRootPath?: string | undefined,
): string[] | undefined {
  const paths = Array.from(
    new Set(
      (summary?.files ?? [])
        .map((file) => file.path.trim())
        .filter((path) => path.length > 0)
        .map((path) => resolveToolCallFilePath(path, fileReferenceRootPath)),
    ),
  );
  return paths.length > 0 ? paths : undefined;
}

export function filterCommitPreviewFilesByCurrentSession(options: {
  files: readonly GitBranchCommitPreviewFile[];
  summary: ZCodeTaskChangeSummary | null;
  gitSummary: GitRepositorySummary;
  workspacePath: string;
  fileReferenceRootPath?: string | undefined;
}): GitBranchCommitPreviewFile[] {
  const scope = buildCurrentSessionFileScope({
    summary: options.summary,
    gitSummary: options.gitSummary,
    workspacePath: options.workspacePath,
    fileReferenceRootPath: options.fileReferenceRootPath,
  });
  return options.files.filter((file) => isPreviewFileInScope(file, scope));
}
