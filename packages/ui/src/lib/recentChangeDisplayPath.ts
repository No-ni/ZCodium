import { resolveFileDisplayBasePath } from "@/lib/fileDisplay.js";
import { toWorkspaceRelativePath } from "@/lib/taskChangeSummary.js";

/**
 * Cmd+P「最近改动」行的展示相对路径（标题与行标签共用）。
 *
 * Bug 原因：这两处原先直接 `toWorkspaceRelativePath(fileSearchRoot, file.path)`，把**文件搜索根**
 * （会话执行 cwd）当成唯一展示基准；而 `file.path` 是模型写进 write/edit 的原文，改动文件里既有
 * 会话目录内的文件，也有 `fileChanges` 里以绝对路径出现、落在对话根（身份根）内的文件
 * （`.zcodium/skills/...`、`.zcodium-share/...` 等）。后者不在搜索根之下，
 * `toWorkspaceRelativePath` 会原样返回绝对路径（见 lib/taskChangeSummary.ts 的末尾回落）。
 *
 * 展示基准因此取「最深包含根」——会话目录命中优先、回落工作区身份根——与文件变更摘要面板
 * `ConversationFileSummaryPanel` 同一套规则（spec 规则 12 的展示/读取两分法）。
 * 注意这只影响**展示**：打开文件仍传 `file.path` 原文（读取基准是模型 cwd，不是展示根）。
 */
export function resolveRecentChangeDisplayPath(params: {
  /** 摘要里的文件路径原文：可能是绝对路径，也可能是模型写的相对路径。 */
  filePath: string;
  /**
   * 文件搜索根（会话已绑定时 = 会话执行 cwd）。会话未绑定 / 旧 CLI 缺席时传 undefined，
   * 此时展示基准只剩工作区身份根 = 改动前行为。
   */
  fileSearchRootPath?: string;
  /** 工作区身份根（对话会话是对话根），任何一环缺省时的展示回落。 */
  workspaceAbsPath: string;
}): string {
  const displayBasePath =
    resolveFileDisplayBasePath(params.filePath, [
      params.fileSearchRootPath,
      params.workspaceAbsPath,
    ]) ?? params.workspaceAbsPath;
  return toWorkspaceRelativePath(displayBasePath, params.filePath);
}
