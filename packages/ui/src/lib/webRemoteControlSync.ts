import type { WindowHostControllerTaskListItem } from "@zcode/services";
import type { WebRemoteControlTaskSync, WebRemoteControlWorkspaceSync } from "@zcode/shared";

interface WorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  workspacePurpose?: "project" | "conversation";
  label?: string;
}

/** 仅把窗口 scope 和 Controller 投影转换成既有手机协议，不保存第二份任务事实。 */
export function buildWebRemoteControlSyncPayload(
  targets: readonly WorkspaceTarget[],
  items: readonly WindowHostControllerTaskListItem[],
): {
  workspaces: WebRemoteControlWorkspaceSync["workspaces"];
  tasks: WebRemoteControlTaskSync["tasks"];
} {
  const byKey = new Map(
    targets.map((target) => [target.workspaceIdentity?.trim() || target.workspacePath, target]),
  );
  return {
    workspaces: Array.from(byKey, ([workspaceKey, target]) => ({
      workspaceKey,
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      remoteSessionId: target.remoteSessionId,
      kind:
        target.remoteSessionId || target.workspaceIdentity
          ? "remote"
          : target.workspacePurpose === "conversation"
            ? "conversation"
            : "local",
      label: target.label,
    })),
    tasks: items.flatMap((task) => {
      const workspaceKey = task.workspaceIdentity?.trim() || task.workspacePath;
      const target = byKey.get(workspaceKey);
      if (
        !target ||
        target.workspacePath !== task.workspacePath ||
        target.remoteSessionId !== task.remoteSessionId
      )
        return [];
      return [
        {
          workspaceKey,
          taskId: task.taskId,
          title: task.title,
          remoteSessionId: task.remoteSessionId,
          // tasks-index 持久化状态没有当前 running；必须采信 Controller 的实时状态。
          displayStatus: task.liveStatus === "waiting" ? "running" : task.liveStatus,
          hasBackgroundWork: task.activity?.hasBackgroundWork,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
          unreadAt: task.unreadAt,
        },
      ];
    }),
  };
}
