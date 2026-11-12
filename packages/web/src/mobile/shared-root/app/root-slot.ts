import type { IPlatformService } from "@zcode/shared";
import type {
  MobileRootDraftRequest,
  MobileRootNavigation,
  MobileRootSlot,
  MobileRootWorkspaceAccess,
  MobileRootWorkspaceSwitcher,
} from "../contract.js";

function initialDraft(draft: MobileRootDraftRequest | undefined, isCurrent: () => boolean) {
  // 无草稿/已有 task 也可能有迟到的 Root effect，必须交接同一初始化租约。
  if (!draft) return { isCurrent };
  let completed = false;
  return {
    ...draft,
    // controller 已在撤下旧 Root 前消费 sender 租约；新 Root 只受目标 slot 租约约束。
    isCurrent,
    onComplete: () => {
      // 真实 Root 已完成初始化才调用；新导航/失效目标不能被通知为成功。
      if (completed || !isCurrent()) return;
      completed = true;
      draft.onComplete?.();
    },
  };
}

/** 只构造同代 Root props；登记、业务初始化和完成事件仍由各自原 owner 执行。 */
export function createMobileRootSlot(
  access: MobileRootWorkspaceAccess,
  navigation: MobileRootNavigation,
  windowId: string,
  platform: IPlatformService,
  switcher: MobileRootWorkspaceSwitcher,
  isCurrent: () => boolean,
): MobileRootSlot {
  return {
    access,
    key: `${windowId}:${access.generation}:${navigation.revision}`,
    rootProps: {
      services: access.services,
      platform,
      initialWorkspaceAbsPath: access.descriptor.workspacePath,
      initialWorkspaceIdentity: access.descriptor.workspaceIdentity,
      initialWorkspacePurpose:
        access.descriptor.kind === "conversation" ? "conversation" : "project",
      initialTaskId: navigation.taskId,
      initialTaskDraft: navigation.taskId
        ? { isCurrent }
        : initialDraft(navigation.draft, isCurrent),
      initialSidebarFileTreeOpen: Boolean(navigation.fileTreeTaskId),
      initialWebRemoteControlMobileNavigationIntent: navigation.mobileNavigationIntent,
      composerClientNamespace: `paired-window:${windowId}`,
      terminalOwnerId: `mobile:${windowId}`,
      restoreSession: false,
      supportsSettings: true,
      allowOpenWorkspace: false,
      allowRemoteWorkspace: false,
      supportsEmbeddedBrowser: false,
      webRemoteControlWorkspaceSwitcher: switcher,
      webRemoteControlTerminalTransportState: "paired",
    },
  };
}
