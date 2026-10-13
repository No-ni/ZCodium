import { buildFileMentionMarkdown } from "@/mentions/mentionMarkdown.js";
import { areWorkspaceFilePathsEqual } from "@/workspace-file-tree/model.js";

export const WORKSPACE_FILE_DRAG_MIME = "application/x-zcode-workspace-file";
export const WORKSPACE_FILE_ADD_TO_CHAT_EVENT = "zcode:add-workspace-file-to-chat";
export const WORKSPACE_FILE_DRAG_STATE_EVENT = "zcode:workspace-file-drag-state";

export interface WorkspaceFileDragPayload {
  type: "file" | "directory";
  workspacePath: string;
  workspaceIdentity?: string;
  /**
   * `relativePath` 的解析根 = 拖拽来源文件树的浏览根。
   *
   * 浏览根与工作区身份在对话会话下不是同一个目录（见
   * docs/specs/conversation-session-workspace.md 的所有者表与已知边界 14）：
   * 文件树根是会话执行 cwd，`workspacePath` 仍是工作区身份（对话根）。
   * 只按身份判「同源」会把 A 会话树里的相对路径投给 B 会话的 composer，
   * 而 B 会话的 Agent 按**自己的** cwd 解析它 → 错文件或不存在。
   * 旧 payload 缺席该字段时按 `workspacePath` 归一化（改动前的语义）。
   */
  fileReferenceRootPath?: string;
  path: string;
  relativePath: string;
  name: string;
}

interface WorkspaceFileComposerMention {
  markdown: string;
  value: string;
  data: {
    kind: WorkspaceFileDragPayload["type"];
    path: string;
    /**
     * 插进 composer 的目标：同源时是相对解析根的 `relativePath`，**不同源时是绝对路径**。
     * 现有消费方（PromptMentionNode / promptMentionDecoration / ContextMentionOptionContent）
     * 都按 `data.path ?? data.relativePath ?? value` 取用，绝对路径的 `data.path` 优先，
     * 因此这里出现绝对路径不会让图标或展示错位；新增消费方必须沿用这个优先级。
     * 另：文件树行的 `text/plain` 兜底是 `[名字](./相对树根的路径)` 形态的 mention markdown
     * （`buildFileMentionMarkdown`），它带不了解析根、也不参与本判据；跨会话拖到纯文本目标时
     * 里面的相对路径仍以来源树根为准。
     */
    relativePath: string;
  };
}

interface WorkspaceFileDragStateDetail {
  dragging: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function serializeWorkspaceFileDragPayload(payload: WorkspaceFileDragPayload): string {
  return JSON.stringify(payload);
}

function parseWorkspaceFileDragPayload(
  rawPayload: string | null | undefined,
): WorkspaceFileDragPayload | null {
  if (!rawPayload) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(rawPayload);
    if (!isRecord(parsed)) {
      return null;
    }

    const type = parsed.type;
    const workspacePath = parsed.workspacePath;
    const path = parsed.path;
    const relativePath = parsed.relativePath;
    const name = parsed.name;
    const workspaceIdentity = parsed.workspaceIdentity;
    const fileReferenceRootPath = parsed.fileReferenceRootPath;

    if (
      (type !== "file" && type !== "directory") ||
      typeof workspacePath !== "string" ||
      typeof path !== "string" ||
      typeof relativePath !== "string" ||
      typeof name !== "string"
    ) {
      return null;
    }

    return {
      type,
      workspacePath,
      path,
      relativePath,
      name,
      ...(typeof workspaceIdentity === "string" && workspaceIdentity.trim()
        ? { workspaceIdentity }
        : {}),
      // 与 workspaceIdentity 同一处理风格：非字符串 / 空白视为缺席（旧 payload），
      // 由 createWorkspaceFileComposerMention 按 workspacePath 归一化。
      ...(typeof fileReferenceRootPath === "string" && fileReferenceRootPath.trim()
        ? { fileReferenceRootPath }
        : {}),
    };
  } catch {
    return null;
  }
}

export function readWorkspaceFileDragPayload(
  dataTransfer: DataTransfer,
): WorkspaceFileDragPayload | null {
  if (!hasWorkspaceFileDragPayload(dataTransfer)) {
    return null;
  }

  return parseWorkspaceFileDragPayload(dataTransfer.getData(WORKSPACE_FILE_DRAG_MIME));
}

export function hasWorkspaceFileDragPayload(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(WORKSPACE_FILE_DRAG_MIME);
}

export function isWorkspaceFileDragStateEvent(
  event: Event,
): event is CustomEvent<WorkspaceFileDragStateDetail> {
  return event.type === WORKSPACE_FILE_DRAG_STATE_EVENT;
}

export function dispatchWorkspaceFileDragState(dragging: boolean): void {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(
    new CustomEvent<WorkspaceFileDragStateDetail>(WORKSPACE_FILE_DRAG_STATE_EVENT, {
      detail: { dragging },
    }),
  );
}

export function isWorkspaceFileAddToChatEvent(
  event: Event,
): event is CustomEvent<WorkspaceFileDragPayload> {
  return event.type === WORKSPACE_FILE_ADD_TO_CHAT_EVENT;
}

export function dispatchWorkspaceFileAddToChat(payload: WorkspaceFileDragPayload): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const event = new CustomEvent(WORKSPACE_FILE_ADD_TO_CHAT_EVENT, {
    cancelable: true,
    detail: payload,
  });
  return !window.dispatchEvent(event);
}

/**
 * 同源判据（两条都要满足）：
 *
 * 1. 工作区身份匹配：`workspacePath` + `workspaceIdentity`（改动前唯一的判据，保持不变）；
 * 2. `relativePath` 的解析根相等：payload 侧 `fileReferenceRootPath ?? workspacePath`
 *    与 composer 侧 `fileReferenceRootPath ?? workspacePath` 归一化比较。
 *
 * 为什么必须加第 2 条：对话会话下文件树根是会话执行 cwd，而 `workspacePath` 是工作区身份
 * （对话根）。同一 workspace 的两个会话（分屏、drop 落到非焦点 pane）身份匹配但解析根不同，
 * 插入的相对路径会被目标会话的 Agent 按它自己的 cwd 解析 → 错文件或不存在
 * （见 docs/specs/conversation-session-workspace.md 已知边界 14）。
 *
 * 不同源时调用方回落 `payload.path`（绝对路径），payload 本来就有这条分支。
 * 旧 payload 没有 `fileReferenceRootPath`：单会话树里两边都归一化成身份根 → 判据与改动前一致；
 * 会话树里（解析根 = 会话目录）归一化成身份根后与 composer 侧不等 → 走绝对路径，
 * 宁可路径变长也不把错的相对路径交给 Agent。
 *
 * 路径比较复用文件树的 `areWorkspaceFilePathsEqual`：它只做「反斜杠 → 正斜杠 + 去尾斜杠」，
 * **不做大小写折叠**，因此盘符大小写不同会被判成不同源（这时回落绝对路径是安全方向，
 * 且两侧路径都由同一份 UI 状态产生，实际不会只差大小写）。与文件树其余路径相等判定共用
 * 同一个定义，不在这里另写一套归一化。
 *
 * 本判据只在 composer 侧解析根**已被会话事实证明**时才有意义：两侧都回落成身份根时它必然
 * 返回 true，而接收方的 cwd 可能根本不是身份根。因此调用方（createWorkspaceFileComposerMention）
 * 先用 `fileReferenceRootResolved` 把「未证明」这一支摘出去。
 */
function isWorkspaceFilePayloadForComposer(
  payload: Pick<
    WorkspaceFileDragPayload,
    "workspacePath" | "workspaceIdentity" | "fileReferenceRootPath"
  >,
  workspacePath: string,
  workspaceIdentity?: string,
  fileReferenceRootPath?: string,
): boolean {
  const identityMatches =
    payload.workspacePath === workspacePath &&
    (payload.workspaceIdentity ?? "") === (workspaceIdentity ?? "");
  if (!identityMatches) {
    return false;
  }

  return areWorkspaceFilePathsEqual(
    payload.fileReferenceRootPath ?? payload.workspacePath,
    fileReferenceRootPath ?? workspacePath,
  );
}

export function createWorkspaceFileComposerMention(
  payload: WorkspaceFileDragPayload,
  workspacePath: string,
  workspaceIdentity?: string,
  fileReferenceRootPath?: string,
  options: { fileReferenceRootResolved?: boolean } = {},
): WorkspaceFileComposerMention {
  // 解析根不是「会话事实」时（草稿态还没有可用的会话快照：预热未就绪 / 首帧身份不匹配）
  // **一律**投绝对路径：接收这批内容的会话可能还没有自己的执行目录，相对路径对谁都不成立
  // ——壳层文件树根与 pane 回落根都是身份根，第 2 条同源判据在这里只会给出「可用」的假结论
  // （见 docs/specs/conversation-session-workspace.md 规则 11、已知边界 14）。
  const sameWorkspace =
    options.fileReferenceRootResolved !== false &&
    isWorkspaceFilePayloadForComposer(
      payload,
      workspacePath,
      workspaceIdentity,
      fileReferenceRootPath,
    );
  const mentionTarget = sameWorkspace ? payload.relativePath : payload.path;

  return {
    markdown: buildFileMentionMarkdown(mentionTarget, payload.name, payload.type),
    value: mentionTarget,
    data: {
      kind: payload.type,
      path: payload.path,
      relativePath: mentionTarget,
    },
  };
}
