import type { MobileRootDraftRequest, MobileRootWorkspaceAccess } from "../contract.js";
import type {
  WebRemoteControlWorkspaceListResult,
  WebRemoteControlWorkspaceRef,
} from "@zcode/shared";

interface DraftHandoffActions {
  isCurrent(): boolean;
  list(): Promise<WebRemoteControlWorkspaceListResult>;
  navigate(
    workspaceKey: string,
    draft: MobileRootDraftRequest,
    onAdmitted: (isCurrent: () => boolean) => void,
  ): Promise<void>;
  reportFailure(): void;
}

/** 复用 controller 的单一导航路径；只在本次调用栈内交接租约，不保存另一份操作事实。 */
export async function handoffMobileProjectDraft(
  access: MobileRootWorkspaceAccess,
  request: MobileRootDraftRequest,
  actions: DraftHandoffActions,
) {
  let current = () => access.isCurrent() && actions.isCurrent() && request.isCurrent?.() !== false;
  try {
    const result = await prepareMobileProjectDraft(
      access,
      request,
      actions.list,
      actions.isCurrent,
    );
    // 原因：发起组件会在交接时卸载；必须在最后一次 await 后、撤下旧 Root 前消费其租约。
    if (!current()) throw new Error("project.navigation-cancelled");
    await actions.navigate(result.workspace.workspaceKey, result.draft, (isCurrent) => {
      current = isCurrent;
    });
  } catch (error) {
    // 已准入的失败只借目标导航租约反馈；旧组件卸载不取消，新导航/失效目标不误报。
    if (current()) {
      actions.reportFailure();
      request.onError?.(error);
    }
    throw error;
  }
}

/** 公开 Host 先固化目录，随后只准入当前桌面已打开且身份完全一致的 workspace。 */
// 显式使用公开契约，避免声明推导跨到 UI 私有 Composer 类型。
export async function prepareMobileProjectDraft(
  access: MobileRootWorkspaceAccess,
  request: MobileRootDraftRequest,
  list: () => Promise<WebRemoteControlWorkspaceListResult>,
  isCurrent: () => boolean,
): Promise<{ workspace: WebRemoteControlWorkspaceRef; draft: MobileRootDraftRequest }> {
  const assertCurrent = () => {
    if (!access.isCurrent() || !isCurrent() || request.isCurrent?.() === false)
      throw new Error("project.navigation-cancelled");
  };
  assertCurrent();
  const projectService = access.services.windowProjectDirectory?.projectService;
  if (!projectService) throw new Error("project.service-unavailable");
  const prepared = await projectService.prepareSession({
    ...(request.projectId ? { projectId: request.projectId } : {}),
    ...(request.hostId ? { hostId: request.hostId } : {}),
    ...(request.draftId ? { draftId: request.draftId, reuseDraft: true } : {}),
  });
  assertCurrent();
  const inventory = await list();
  assertCurrent();
  const key = prepared.workspaceIdentity?.trim() || prepared.workspacePath;
  const workspace = inventory.workspaces.find(
    (candidate) =>
      candidate.workspaceKey === key &&
      candidate.workspacePath === prepared.workspacePath &&
      (candidate.workspaceIdentity?.trim() || candidate.workspacePath) === key,
  );
  // 原因：prepareSession 不授予桌面窗口 bridge；不能把新 cwd 伪造成已打开的工作区。
  if (!workspace || (workspace.kind === "remote" && workspace.connectionState !== "connected"))
    throw new Error("project.remote-navigation-unavailable");
  if (
    request.targetWorkspace &&
    (request.targetWorkspace.workspacePath !== prepared.workspacePath ||
      (request.targetWorkspace.workspaceIdentity?.trim() ||
        request.targetWorkspace.workspacePath) !== key)
  )
    throw new Error("project.workspace-scope-mismatch");
  if (request.expectedWorkspaceKey && request.expectedWorkspaceKey !== key)
    throw new Error("project.workspace-scope-mismatch");
  return {
    workspace,
    draft: {
      ...request,
      projectId: prepared.projectId,
      targetWorkspace: {
        ...request.targetWorkspace,
        workspacePath: prepared.workspacePath,
        workspaceIdentity: prepared.workspaceIdentity,
      },
    },
  };
}
