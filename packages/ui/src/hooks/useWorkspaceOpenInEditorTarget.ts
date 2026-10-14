import { createOpenInEditorRemoteTarget } from "@zcode/shared";
import { useMemo } from "react";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab, type WindowTabState, type WorkspaceTabState } from "@/store/tabStore.js";
import { isSameWorkspaceTab } from "@/store/tabWorkspaceIdentity.js";

interface WorkspaceOpenInEditorScope {
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

  const requestedIdentity = scope.workspaceIdentity?.trim() || undefined;
  const requestedRemoteSessionId = scope.workspaceRemoteSessionId?.trim() || undefined;
  const useAmbientPath =
    scope.scopeResolution === "ambient" && !requestedIdentity && !requestedRemoteSessionId;
  const isRemoteWorkspace = Boolean(requestedIdentity || requestedRemoteSessionId);
  const matches = tabs.filter((tab): tab is WorkspaceTabState => {
    return (
      isWorkspaceTab(tab) &&
      (useAmbientPath
        ? tab.workspacePath === scope.workspacePath
        : isSameWorkspaceTab(tab, scope.workspacePath!, {
            workspaceIdentity: requestedIdentity,
            remoteSessionId: requestedRemoteSessionId,
          })) &&
      (!requestedRemoteSessionId || tab.remoteSessionId?.trim() === requestedRemoteSessionId)
    );
  });
  // 缺席身份明确表示本地来源，不能借同路径远程 tab；显式远程来源缺 tab/target
  // 仍保持远程判据，让调用方拒绝打开而不是将远程路径交给本机编辑器。
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
