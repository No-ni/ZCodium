/**
 * 对话工作区（未指定项目的会话）标记。
 *
 * 未指定项目的会话共用一个「对话根」（`~/.zcodium/workspace/default`）作为工作区身份，
 * 但每个会话需要一个独立的执行 cwd，否则并行会话会互相看见对方的临时文件与产物。
 * 身份与执行目录的归属不同：**谁是对话根**只有 Host 知道（`getConversationWorkspaceDir()`），
 * **目录怎么建**只有会话所有者 Agent CLI 知道（会话 id 由 CLI 铸造），因此这个事实
 * 只能在 spawn 边界由 Host 下发给 Agent。详见 docs/specs/conversation-session-workspace.md。
 *
 * 语义：值等于对话根路径时，CLI 对该进程内的会话启用「独立会话目录」规则；
 * 未注入（CLI/TUI 直接运行、远程 workspace、项目工作区）保持旧行为（cwd = workspacePath）。
 */
export const ZCODE_CONVERSATION_WORKSPACE_ROOT_ENV = "ZCODE_CONVERSATION_WORKSPACE_ROOT";

/** 读取 Host 下发的对话根标记；空串与缺席等价（都表示「不启用」）。 */
export function resolveConversationWorkspaceRoot(
  env: Record<string, string | undefined> | undefined,
): string | undefined {
  const trimmed = env?.[ZCODE_CONVERSATION_WORKSPACE_ROOT_ENV]?.trim();
  return trimmed ? trimmed : undefined;
}
