import type { V4ConversationFileChangesResult } from "@zcode/shared/zcode-protocol-v4";
import { resolveFileDisplayBasePath } from "@/lib/fileDisplay.js";
import { resolveToolCallFilePath } from "@/ToolCallBlocks/fileSummaryTypes.js";
import { toWorkspaceRelativePath } from "@/lib/taskChangeSummary.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";

type FileChangeItem = V4ConversationFileChangesResult["items"][number];

function formatPatch(path: string, patches: FileChangeItem["patches"]): string {
  if (patches.length === 0) return "";
  const lines = [`--- a/${path}`, `+++ b/${path}`];
  for (const patch of patches) {
    lines.push(
      `@@ -${patch.oldStart},${patch.oldLines} +${patch.newStart},${patch.newLines} @@`,
      ...patch.lines,
    );
  }
  return lines.join("\n");
}

export function openDiff(
  item: FileChangeItem,
  context: Pick<
    ConversationRowRenderContext,
    | "workspacePath"
    | "fileSearchRootPath"
    | "workspaceIdentity"
    | "workspaceRemoteSessionId"
    | "onOpenCodeViewer"
  >,
) {
  const patch = formatPatch(item.path, item.patches);
  const { workspacePath, workspaceIdentity, workspaceRemoteSessionId, onOpenCodeViewer } = context;
  if (!patch || !onOpenCodeViewer) return;
  // `item.path` 是模型写进 write/edit 的**原文**（可为相对路径，基准是它当时的执行 cwd）。
  // 展示标题按最深包含根算；读取/打开路径必须按模型 cwd 解析，否则 diff tab 的「查看源文件」
  // 会把相对路径拼到工作区身份根上（对话会话下指向对话根的同名文件或不存在）。
  const readablePath = readSummaryFilePath(item.path, context);
  const displayBasePath =
    resolveFileDisplayBasePath(item.path, [context.fileSearchRootPath, workspacePath]) ??
    workspacePath;
  const relativePath = toWorkspaceRelativePath(displayBasePath, item.path);
  onOpenCodeViewer({
    type: "patch",
    title: relativePath,
    path: readablePath,
    patch,
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(workspaceRemoteSessionId ? { workspaceRemoteSessionId } : {}),
  });
}

/**
 * 文件变更项里「真去读」的路径：`item.path` 是模型写的原文（相对路径的基准是会话执行 cwd），
 * 读取/打开必须按它解析；展示仍走 `resolveFileDisplayBasePath`（见 spec 规则 11/12）。
 */
export function readSummaryFilePath(
  path: string,
  context: Pick<ConversationRowRenderContext, "workspacePath" | "fileSearchRootPath">,
): string {
  return resolveToolCallFilePath(path, context.fileSearchRootPath ?? context.workspacePath);
}
