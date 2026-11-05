import { basename, dirname, isAbsolute, resolve } from "node:path";

/**
 * Host 下发的可信默认对话根。普通 task 的目录由 Host prepareSession 创建；旧 default
 * 根内的会话目录由 CLI 分配。CLI allocator 仍只对请求路径恰好等于该根的本地会话启用，
 * 独立 task 不再套一层日期/会话目录。Gen UI 使用此标记共同识别 app 管理目录。
 * 详见 docs/specs/projectless-task-workspaces.md 与 conversation-session-workspace.md。
 */
export const ZCODE_CONVERSATION_WORKSPACE_ROOT_ENV = "ZCODE_CONVERSATION_WORKSPACE_ROOT";

const taskDirectoryPattern =
  /^(?:draft|\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 只识别 Host 管理的默认根和直接 task 目录，不从项目归属或任意路径后代推导。 */
export function isManagedConversationWorkspace(
  workspacePath: string | undefined,
  workspaceIdentity: string | undefined,
  conversationWorkspaceRoot: string | undefined,
): boolean {
  const path = workspacePath?.trim();
  const root = conversationWorkspaceRoot?.trim();
  if (workspaceIdentity?.trim() || !path || !root || !isAbsolute(path) || !isAbsolute(root))
    return false;
  const workspace = resolve(path);
  const conversation = resolve(root);
  // 原因：独立 task 与无 root 项目都在 workspace 下；必须限定已存在的 task 命名合同，
  // 不能把 bare project UUID、任务后代或根外同名目录授权为本地任务产物目录。
  return (
    workspace === conversation ||
    (dirname(workspace) === dirname(conversation) && taskDirectoryPattern.test(basename(workspace)))
  );
}

/** 读取 Host 下发的对话根标记；空串与缺席等价（都表示「不启用」）。 */
export function resolveConversationWorkspaceRoot(
  env: Record<string, string | undefined> | undefined,
): string | undefined {
  const trimmed = env?.[ZCODE_CONVERSATION_WORKSPACE_ROOT_ENV]?.trim();
  return trimmed ? trimmed : undefined;
}
