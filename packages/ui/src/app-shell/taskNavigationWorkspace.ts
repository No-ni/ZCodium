import { isSameWorkspaceTab } from "@/store/tabWorkspaceIdentity.js";

export function findTaskNavigationWorkspaceTab<
  T extends {
    workspacePath: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
    remoteTarget?: unknown;
  },
>(
  tabs: readonly T[],
  target: { workspacePath: string; workspaceIdentity?: string; remoteSessionId?: string },
): T | undefined {
  // 旧远程 tab 可能只有 attachment/target；复用 tab 身份判据，避免本地请求借到远程 Host。
  const workspaceIdentity = target.workspaceIdentity?.trim();
  const remoteSessionId = target.remoteSessionId?.trim();
  return tabs.find(
    (tab) =>
      // identity 是稳定键，路径规范化不应使已绑定 tab 失联；已知 attachment 则必须防止重连换代串线。
      (workspaceIdentity
        ? tab.workspaceIdentity?.trim() === workspaceIdentity
        : isSameWorkspaceTab(tab, target.workspacePath, target)) &&
      (!remoteSessionId || tab.remoteSessionId?.trim() === remoteSessionId),
  );
}

type TaskNavigationWorkspaceResult =
  | { accepted: true; openedLocalTab: boolean }
  | { accepted: false; reason: "remote_attachment_missing" };

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
  const remoteSessionId = params.remoteSessionId?.trim();
  if (
    params.activateTabByPath(
      params.workspacePath,
      workspaceIdentity || remoteSessionId ? { workspaceIdentity, remoteSessionId } : undefined,
    )
  ) {
    return { accepted: true, openedLocalTab: false };
  }

  if (workspaceIdentity || remoteSessionId) {
    // 远程 workspace 的 identity 只表达隔离身份，不能据此重建 SSH/WSL/Docker
    // attachment。当前窗口没有匹配 tab 时必须 fail-closed，避免创建无法连接的伪远程 tab。
    return { accepted: false, reason: "remote_attachment_missing" };
  }

  // Automations 是跨项目列表，运行历史所属的本地 workspace 可能已经关闭。
  // 只尝试 activate 的话，失败后仍关闭 Automations，最终留在当前项目的旧会话。
  params.addLocalWorkspaceTab(params.workspacePath);
  return { accepted: true, openedLocalTab: true };
}
