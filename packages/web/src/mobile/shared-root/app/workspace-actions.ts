import type {
  WebRemoteControlTaskTarget,
  WebRemoteControlWorkspaceListResult,
  WebRemoteControlWorkspaceSwitchOptions,
} from "@zcode/shared";
import type {
  MobileRootDraftRequest,
  MobileRootSlot,
  MobileRootWorkspaceAccess,
  MobileRootWorkspaceSwitcher,
  MobileSharedRootTransport,
} from "../contract.js";

interface WorkspaceActions {
  client: MobileSharedRootTransport;
  isCurrent(): boolean;
  assertAccess(access: MobileRootWorkspaceAccess): void;
  readWorkspaceList(
    access: MobileRootWorkspaceAccess,
  ): Promise<WebRemoteControlWorkspaceListResult>;
  subscribeList(listener: (result: WebRemoteControlWorkspaceListResult) => void): () => void;
  navigate(key: string, options?: WebRemoteControlWorkspaceSwitchOptions): Promise<void>;
  openProjectDraft(
    access: MobileRootWorkspaceAccess,
    request: MobileRootDraftRequest,
  ): Promise<void>;
  updateNavigation(key: string, taskId?: string): void;
  reconnectWorkspace(access: MobileRootWorkspaceAccess, key: string): Promise<void>;
}

export async function markMobileTaskRead(
  access: MobileRootWorkspaceAccess,
  taskId: string,
  expectedUnreadAt: number | undefined,
  assertCurrent: () => void,
) {
  assertCurrent();
  if (typeof expectedUnreadAt !== "number") return;
  const descriptor = access.descriptor;
  await access.services.windowControllerService.mutateTask({
    address: {
      workspacePath: descriptor.workspacePath,
      workspaceIdentity: descriptor.workspaceIdentity,
      remoteSessionId: descriptor.remoteSessionId,
      taskId,
    },
    mutation: { kind: "mark-read", expectedUnreadAt },
  });
  assertCurrent();
}

export async function markMobileOpenedTaskRead(
  slot: MobileRootSlot | undefined,
  options: WebRemoteControlWorkspaceSwitchOptions | undefined,
) {
  if (!slot || !options?.taskId || typeof options.markTaskReadExpectedUnreadAt !== "number") return;
  try {
    // 跨工作区必须由已就绪的目标 Host 执行 CAS；实际查看上报不能替代已读命令。
    await markMobileTaskRead(
      slot.access,
      options.taskId,
      options.markTaskReadExpectedUnreadAt,
      () => {
        if (slot.rootProps.initialTaskDraft?.isCurrent?.() !== true)
          throw new Error("mobile-workspace-superseded");
      },
    );
  } catch {
    // 已读失败保留已打开目标；不无条件重试，也不覆盖 Host 的新 unreadAt。
  }
}

async function markTaskRead(
  access: MobileRootWorkspaceAccess,
  task: WebRemoteControlTaskTarget,
  assertCurrent: () => void,
) {
  const descriptor = access.descriptor;
  if (
    task.workspacePath !== descriptor.workspacePath ||
    (task.workspaceIdentity?.trim() || task.workspacePath) !== descriptor.workspaceKey ||
    // 共享项目行不保存连接 ID；显式错误 ID 拒绝，实际 CAS 始终用可信 descriptor 寻址。
    (task.remoteSessionId !== undefined && task.remoteSessionId !== descriptor.remoteSessionId)
  )
    throw new Error("mobile-workspace-scope-unavailable");
  await markMobileTaskRead(access, task.taskId, task.unreadAt, assertCurrent);
}

/** 每个方法借同代 port；不保存任务事实、输入或另一份导航状态。 */
export function createMobileWorkspaceSwitcher(
  access: MobileRootWorkspaceAccess,
  actions: WorkspaceActions,
): MobileRootWorkspaceSwitcher {
  const navigate = async (key: string, options?: WebRemoteControlWorkspaceSwitchOptions) => {
    actions.assertAccess(access);
    await actions.navigate(key, options);
  };
  return {
    listWorkspaces: () => actions.readWorkspaceList(access),
    onWorkspaceListUpdated: (listener) =>
      actions.subscribeList((result) => {
        if (actions.isCurrent()) listener(result);
      }),
    switchWorkspace: navigate,
    startDraft: navigate,
    openProjectDraft: async (request) => {
      actions.assertAccess(access);
      await actions.openProjectDraft(access, request);
    },
    updateMobileViewState: async (key, taskId) => {
      // 相同 bridge 换 task/草稿后 access 仍有效；旧 Reporter 只按 slot 租约静默收尾。
      if (!actions.isCurrent()) return;
      actions.assertAccess(access);
      if (key !== access.descriptor.workspaceKey)
        throw new Error("mobile-workspace-scope-unavailable");
      actions.updateNavigation(key, taskId);
      actions.client.sendPayload({
        zcode_type: "mobile-view-state-update",
        viewState: { activeWorkspaceKey: key, ...(taskId ? { activeTaskId: taskId } : {}) },
      });
    },
    updateMobileTaskView: async (view) => {
      // 原因：旧 Root 的卸载可能晚于新 bridge；旧清理不得撤销新代实际查看。
      if (actions.isCurrent()) actions.client.updateMobileTaskView(view);
    },
    markTaskRead: async (task) => {
      actions.assertAccess(access);
      await markTaskRead(access, task, () => actions.assertAccess(access));
      actions.assertAccess(access);
    },
    reconnectWorkspace: (key) => actions.reconnectWorkspace(access, key),
  };
}
