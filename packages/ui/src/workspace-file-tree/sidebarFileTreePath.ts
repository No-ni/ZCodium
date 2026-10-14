import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { isWorkspaceFilePathInside } from "@/workspace-file-tree/model.js";

/** 侧栏文件树的目标工作区；字段与 `WorkspaceSidebar` 的打开请求一一对应。 */
export interface SidebarFileTreeTarget {
  workspacePath: string;
  workspaceName: string;
  /**
   * 这次请求属于**哪个会话**（任务行的 `task.taskId`）。缺席 = 请求不绑定某个会话
   * （markdown 链接 / Git 面板的 reveal、tab 级请求）。
   *
   * 为什么必须有：对话工作区里**每个**会话的 `workspacePath` 都是对话根，所以「点任务 B 的
   * 文件树按钮」产生的 target 与激活 tab 的 workspaceKey 相等——只看 key 无法区分「当前 tab
   * 自己的树」与「另一个会话的树」，树根会被换成**激活会话 A** 的执行目录：用户点 B 却看到 A
   * 的文件，拖拽/Add to chat 拿到的也是 A 的文件。判据因此加上「这次请求是哪个会话的」。
   * null 表示 tab 明确不绑定当前会话；undefined 仍表示 tab/reveal 级请求。
   */
  taskId?: string | null;
  /** 由本次 task 打开动作解析并冻结的 cwd，避免后续激活会话变化改写任务文件树归属。 */
  executionWorkspacePath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  revealPath?: string;
  temporaryExternalDirectory?: boolean;
}

/**
 * 文件树的归属目录（= 树根 / 浏览根）。
 *
 * 当前 workspace tab 自己的树跟随活动会话执行 cwd；任务行请求在动作时解析并冻结自己的
 * executionWorkspacePath。其它 tab、临时外部目录及未绑定会话仍用目标自身的工作区路径。
 * 见 docs/specs/conversation-session-workspace.md 的所有者表与规则 4。
 *
 * 例外（已知边界 4 后半）：reveal 目标落在**工作区身份根内、会话目录之外**时
 * （例如 `<对话根>/.zcodium-share/...`，或用户直接放在对话根的文件），以会话目录为树根时
 * `WorkspaceFileTree` 的 `isWorkspaceFilePathInside(workspacePath, revealPath)` 会判否并直接
 * return——链接能打开文件，但树不展开、也没有任何反馈。这里把**这一次 reveal 的树根**切回
 * 身份根，树才有机会展开到目标。
 *
 * 边界与自洽性：
 * - 只影响这一次 reveal 的树根。用户关掉再打开文件树时新的 `fileTreeTarget` 不带 `revealPath`，
 *   于是回到会话目录，不会永久顶掉会话视图（这正是本取舍可接受的原因）。
 * - `workspaceScopePath`（忽略规则根 / 拖拽与 Add to chat 的归属）仍由调用方传目标自身的
 *   工作区路径，不随树根变化；树根切到身份根时两者恰好相等，也只是同一条规则的取值。
 * - 树根切到身份根后，行拖拽 / Add to chat 的 `relativePath` 是相对身份根的。payload 现在带
 *   `fileReferenceRootPath`（见 `lib/workspaceFileDrag.ts`），composer 只在解析根相等时才用
 *   相对路径，否则插入绝对路径，因此不会把身份根相对路径交给会话目录里的 Agent。
 */
export function resolveSidebarFileTreePath(params: {
  target: SidebarFileTreeTarget;
  activeWorkspaceKey: string;
  /** shell 绑定的会话（`activeTaskId`）；undefined/null = 草稿态。 */
  activeTaskId?: string | null | undefined;
  activeSessionWorkspacePath?: string | null;
}): string {
  const targetWorkspaceKey = buildTaskWorkspaceKey(
    params.target.workspacePath,
    params.target.workspaceIdentity,
  );
  let sessionWorkspacePath = params.target.executionWorkspacePath?.trim() || null;
  if (!sessionWorkspacePath) {
    if (targetWorkspaceKey !== params.activeWorkspaceKey || !params.activeSessionWorkspacePath) {
      return params.target.workspacePath;
    }
    // 请求绑定了别的会话（任务行的树）时不能借用激活会话的目录：同一对话工作区里所有会话的
    // workspacePath 都是对话根，key 相等分辨不出它们。`taskId` 缺席（reveal / tab 级请求）时
    // 才认为「这就是当前 tab 自己的树」。
    // 根因：当前草稿的 activeTaskId 也是 null；显式 null 仍是另一个 tab 的身份根请求，不能借预热目录。
    if (
      params.target.taskId === null ||
      (params.target.taskId !== undefined && params.target.taskId !== params.activeTaskId)
    ) {
      return params.target.workspacePath;
    }
    sessionWorkspacePath = params.activeSessionWorkspacePath;
  }

  // 空白 revealPath 等同于"没有 reveal"（WorkspaceFileTree 也按 trim 后判空）。
  const revealPath = params.target.revealPath?.trim();
  if (
    revealPath &&
    !isWorkspaceFilePathInside(sessionWorkspacePath, revealPath) &&
    isWorkspaceFilePathInside(params.target.workspacePath, revealPath)
  ) {
    return params.target.workspacePath;
  }

  return sessionWorkspacePath;
}
