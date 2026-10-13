import type { MutableRefObject } from "react";
// LexicalChatInput 壳恢复后回归原始句柄类型（过渡的 ComposerInputHandle 最小面退役）。
import type { LexicalChatInputHandle } from "@/LexicalChatInput.js";
import {
  createWorkspaceFileComposerMention,
  type WorkspaceFileDragPayload,
} from "@/lib/workspaceFileDrag.js";

export function appendWorkspaceFileMentionToComposer(params: {
  inputApiRef: MutableRefObject<LexicalChatInputHandle | null>;
  currentMarkdown: string;
  payload: WorkspaceFileDragPayload;
  workspacePath: string;
  workspaceIdentity?: string;
  /**
   * 目标 composer 的 `relativePath` 解析根（会话已绑定时 = 会话执行 cwd，见
   * `docs/specs/conversation-session-workspace.md`）。缺席时按 `workspacePath` 归一化；
   * 与 payload 的解析根不等时只插入绝对路径（同源判据见 createWorkspaceFileComposerMention）。
   */
  fileReferenceRootPath?: string;
  /**
   * `fileReferenceRootPath` 是否已由会话事实解析出来（缺省 true = 改动前行为）。
   * false ⇒ 接收这批内容的会话 cwd 未知，插入**绝对路径**：对话工作区里它就是首发要新铸的
   * 会话目录，相对路径会被 Agent 按那个目录解析而找不到文件（已知边界 14）。
   */
  fileReferenceRootResolved?: boolean;
  onTextChange: (text: string) => void;
}) {
  const mention = createWorkspaceFileComposerMention(
    params.payload,
    params.workspacePath,
    params.workspaceIdentity,
    params.fileReferenceRootPath,
    { fileReferenceRootResolved: params.fileReferenceRootResolved },
  );
  const separator =
    params.currentMarkdown.length > 0 && !/\s$/.test(params.currentMarkdown) ? " " : "";
  const nextText = `${params.currentMarkdown}${separator}${mention.markdown} `;

  params.onTextChange(nextText);
  params.inputApiRef.current?.appendFileMention(
    params.payload.name,
    mention.value,
    mention.markdown,
    mention.data,
  );
  params.inputApiRef.current?.focus();

  return nextText;
}
