import { createOpenInEditorRemoteTarget } from "@zcode/shared";
import { useMemo } from "react";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab, type WindowTabState, type WorkspaceTabState } from "@/store/tabStore.js";

export interface WorkspaceOpenInEditorScope {
  workspacePath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  scopeResolution?: "ambient" | "exact";
}

export function resolveWorkspaceOpenInEditorTarget(
  tabs: readonly WindowTabState[],
  scope: WorkspaceOpenInEditorScope,
) {
  if (!scope.workspacePath) {
    return { isRemoteWorkspace: false, remoteTarget: undefined };
  }

  // 远端身份由调用方冻结；只有旧 ambient 预览可以按唯一匹配目录推断线路。
  const useAmbientPath = scope.scopeResolution === "ambient";
  const isRemoteWorkspace = Boolean(
    scope.workspaceIdentity?.trim() || scope.workspaceRemoteSessionId?.trim(),
  );
  const requestedIdentity = scope.workspaceIdentity?.trim() || undefined;
  const requestedRemoteSessionId = scope.workspaceRemoteSessionId?.trim() || undefined;
  const workspaceKey = requestedIdentity || scope.workspacePath;
  const matches = tabs.filter((tab): tab is WorkspaceTabState => {
    if (!isWorkspaceTab(tab) || tab.workspacePath !== scope.workspacePath) {
      return false;
    }

    const tabWorkspaceKey = tab.workspaceIdentity?.trim() || tab.workspacePath;
    const tabRemoteSessionId = tab.remoteSessionId?.trim() || undefined;
    return (
      (!requestedIdentity || tabWorkspaceKey === workspaceKey) &&
      (!requestedRemoteSessionId || tabRemoteSessionId === requestedRemoteSessionId)
    );
  });
  // 修复原因：远程文件动作以前只携带 Linux path，renderer 无法判断它属于哪个 SSH/WSL 目标；
  // identity/session 已提供时精确匹配，旧调用仅在工作区匹配唯一时提取既有脱敏目标。
  const matchedTab = matches.length === 1 ? matches[0] : undefined;
  const isRemoteTarget =
    isRemoteWorkspace ||
    (useAmbientPath &&
      matches.some((tab) =>
        Boolean(tab.workspaceIdentity || tab.remoteSessionId || tab.remoteTarget),
      ));
  const remoteTarget = isRemoteTarget ? matchedTab?.remoteTarget : undefined;
  return {
    isRemoteWorkspace: isRemoteTarget,
    remoteTarget: remoteTarget ? createOpenInEditorRemoteTarget(remoteTarget) : undefined,
  };
}

export function useWorkspaceOpenInEditorTarget(scope: WorkspaceOpenInEditorScope) {
  const tabs = useOptionalTabStore((state) => state.tabs);

  return useMemo(
    () => resolveWorkspaceOpenInEditorTarget(tabs, scope),
    [
      scope.workspaceIdentity,
      scope.workspacePath,
      scope.workspaceRemoteSessionId,
      scope.scopeResolution,
      tabs,
    ],
  );
}
