import type { EditorInfo, OpenInEditorRemoteTarget } from "@zcode/shared";
import type { IDisposable } from "@zcode/rpc";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { WorkspaceFileGitStatus, WorkspaceFileTreeRow } from "@/workspace-file-tree/model.js";

export interface WorkspaceFileTreeProps {
  /** 文件树浏览根。会话已绑定时是会话执行 cwd，否则是 tab 的 workspacePath。 */
  workspacePath: string;
  workspaceName?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  /**
   * 工作区身份路径（tab 的 workspacePath）。缺省 = `workspacePath`。
   *
   * `workspacePath` 换成会话 cwd 后，两处仍必须按工作区身份走：
   * 1. 忽略规则根（`.zcodiumignore` 所在目录）——规则只有一份、落在对话根上，
   *    不在会话目录里生成规则文件（见 conversation-session-workspace spec 规则 10）；
   * 2. 拖拽 / 「Add to chat」payload 的 workspace 归属——composer 按 tab 的 workspacePath
   *    匹配来源，payload 里写会话目录会让引用被丢弃。
   *
   * 相对路径的解析根是 `workspacePath`（浏览根），随 payload 的 `fileReferenceRootPath`
   * 一起下发：同源判据还要求它与目标 composer 的会话执行 cwd 相等，否则只插入绝对路径
   * （见 lib/workspaceFileDrag.ts 与 conversation-session-workspace spec 已知边界 14）。
   */
  workspaceScopePath?: string;
  revealPath?: string;
  temporaryExternalDirectory?: boolean;
  canOpenLocalFileManager?: boolean;
  activePreviewPath?: string | null;
  onClose: () => void;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenPreview?: (source: CodeViewerSource) => void;
}

export interface WorkspaceFileTreeWatcherRegistration {
  id: string;
  subscription: IDisposable;
  unwatch: () => Promise<void>;
}

export interface WorkspaceFileTreeStickyFolderItem {
  row: WorkspaceFileTreeRow;
  index: number;
}

export interface WorkspaceFileTreeContextMenuLabels {
  addToChat: string;
  copyAbsolutePath: string;
  copyRelativePath: string;
  open: string;
  openInBrowser: string;
  openFailed: string;
  openWith: string;
  reveal: string;
}

export interface WorkspaceFileTreeEditorState {
  canOpenLocalFileManager: boolean;
  installedEditors: EditorInfo[];
  isRemoteWorkspaceFileTree: boolean;
  remoteTarget?: OpenInEditorRemoteTarget;
}

export type WorkspaceFileGitStatusLabels = Record<WorkspaceFileGitStatus, string>;
