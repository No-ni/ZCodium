export type TaskNavigationWorkspaceResult =
  | { accepted: true; openedLocalTab: boolean }
  | { accepted: false; reason: "remote_attachment_missing" };

interface TaskNavigationWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  remoteTarget?: unknown;
}

export function findTaskNavigationWorkspaceTab<T extends TaskNavigationWorkspaceTarget>(
  tabs: readonly T[],
  target: TaskNavigationWorkspaceTarget,
): T | undefined {
  const identity = target.workspaceIdentity?.trim();
  return tabs.find((tab) => {
    // identity 是隔离身份，路径可为别名；显式 attachment 还需复验，避免借用换代连接。
    if (identity) {
      return (
        tab.workspaceIdentity?.trim() === identity &&
        (!target.remoteSessionId || tab.remoteSessionId === target.remoteSessionId)
      );
    }
    if (tab.workspacePath !== target.workspacePath) return false;
    if (target.remoteSessionId) return tab.remoteSessionId === target.remoteSessionId;
    // 同路径的旧 session-only 或 target-only 远端也不能充当本地目录。
    return !tab.workspaceIdentity?.trim() && !tab.remoteSessionId && !tab.remoteTarget;
  });
}

export function ensureTaskNavigationWorkspace(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  activateTabByPath: (
    workspacePath: string,
    options?: { workspaceIdentity?: string; remoteSessionId?: string },
  ) => boolean;
  addLocalWorkspaceTab: (workspacePath: string) => void;
}): TaskNavigationWorkspaceResult {
  const workspaceIdentity = params.workspaceIdentity?.trim();
  if (
    params.activateTabByPath(
      params.workspacePath,
      workspaceIdentity || params.remoteSessionId
        ? {
            workspaceIdentity,
            ...(params.remoteSessionId ? { remoteSessionId: params.remoteSessionId } : {}),
          }
        : undefined,
    )
  ) {
    return { accepted: true, openedLocalTab: false };
  }

  if (workspaceIdentity || params.remoteSessionId) {
    // 远程 workspace 的 identity 只表达隔离身份，不能据此重建 SSH/WSL/Docker
    // attachment。当前窗口没有匹配 tab 时必须 fail-closed，避免创建无法连接的伪远程 tab。
    return { accepted: false, reason: "remote_attachment_missing" };
  }

  // Automations 是跨项目列表，运行历史所属的本地 workspace 可能已经关闭。
  // 只尝试 activate 的话，失败后仍关闭 Automations，最终留在当前项目的旧会话。
  params.addLocalWorkspaceTab(params.workspacePath);
  return { accepted: true, openedLocalTab: true };
}
