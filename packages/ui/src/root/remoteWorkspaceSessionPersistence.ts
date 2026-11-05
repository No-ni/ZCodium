import type { AppSettings, RemoteWorkspaceSessionEntry } from "@zcode/shared";
import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import {
  buildWorkspaceSessionKey,
  readPersistedWorkspaceSessionEntries,
  resolveRemoteWorkspaceSessionIdentity,
} from "@/lib/remoteWorkspaceHistory.js";
import { logger } from "@/logger.js";
import {
  isWorkspaceTab,
  type RestorableWorkspaceTab,
  type TabStore,
  type TabStoreState,
} from "@/store/tabStore.js";

function getRestorableWorkspaceKey(tab: string | RestorableWorkspaceTab): string {
  if (typeof tab === "string") {
    return tab;
  }
  return tab.workspaceIdentity?.trim() || tab.workspacePath;
}

function resolveRemoteConversationWorkspacePurpose(
  entry: Pick<
    RemoteWorkspaceSessionEntry,
    "workspaceIdentity" | "workspacePath" | "workspacePurpose"
  >,
  conversationWorkspaceMap: AppSettings["remoteConversationWorkspaceBySourceServerId"],
): RemoteWorkspaceSessionEntry["workspacePurpose"] {
  const parsedIdentity = parseRemoteWorkspaceIdentity(entry.workspaceIdentity ?? "");
  const canonicalConversationPath = parsedIdentity?.sourceServerId
    ? conversationWorkspaceMap?.[parsedIdentity.sourceServerId]?.workspacePath
    : undefined;
  return canonicalConversationPath === entry.workspacePath
    ? "conversation"
    : entry.workspacePurpose;
}

export function projectRemoteConversationWorkspacePurpose(
  remoteSessions: readonly RemoteWorkspaceSessionEntry[],
  conversationWorkspaceMap: AppSettings["remoteConversationWorkspaceBySourceServerId"],
): {
  remoteSessions: RemoteWorkspaceSessionEntry[];
  updatedEntries: Array<{
    workspacePath: string;
    workspaceIdentity?: string;
  }>;
} {
  const updatedEntries: Array<{
    workspacePath: string;
    workspaceIdentity?: string;
  }> = [];
  const projectedSessions = remoteSessions.map((entry) => {
    const workspacePurpose = resolveRemoteConversationWorkspacePurpose(
      entry,
      conversationWorkspaceMap,
    );
    if (workspacePurpose !== "conversation" || entry.workspacePurpose === "conversation") {
      return entry;
    }
    updatedEntries.push({
      workspacePath: entry.workspacePath,
      ...(entry.workspaceIdentity ? { workspaceIdentity: entry.workspaceIdentity } : {}),
    });
    return { ...entry, workspacePurpose };
  });
  return { remoteSessions: projectedSessions, updatedEntries };
}

/** 窗口只拥有活动选择；项目集合与旧版凭据快照由 Host 派生。 */
export function buildRemoteWorkspacePersistPatch(
  state: TabStoreState,
  remoteSessions: readonly RemoteWorkspaceSessionEntry[],
): Partial<AppSettings> {
  const activeKey = state.activeWorkspaceIdentity?.trim() || state.activeWorkspacePath;
  const tab = state.tabs
    .filter(isWorkspaceTab)
    .find((candidate) => buildWorkspaceSessionKey(candidate) === activeKey);
  if (!tab) return { lastActiveWorkspace: null };
  if (tab.workspaceIdentity || tab.remoteSessionId) {
    const remote = remoteSessions.find((entry) => buildWorkspaceSessionKey(entry) === activeKey);
    // 绑定仍在进行时没有可保存的远端快照；不能把远端路径写成本机目录。
    return remote ? { lastActiveWorkspace: remote } : {};
  }
  return {
    lastActiveWorkspace: {
      kind: "local",
      workspacePath: tab.workspacePath,
      ...(tab.workspacePurpose ? { workspacePurpose: tab.workspacePurpose } : {}),
    },
  };
}

export function restorePersistedRemoteWorkspaceSessions({
  settings,
  tabStoreApi,
  allowRemoteWorkspaceRestore = true,
  unavailableWorkspacePath,
  remoteConversationWorkspaceBySourceServerId,
  restoreMode = "all",
}: {
  settings: AppSettings;
  tabStoreApi: TabStore;
  allowRemoteWorkspaceRestore?: boolean;
  unavailableWorkspacePath?: string;
  remoteConversationWorkspaceBySourceServerId?: AppSettings["remoteConversationWorkspaceBySourceServerId"];
  restoreMode?: "all" | "active-first";
}): { deferredRestore?: () => void } | undefined {
  const persistedSessions = readPersistedWorkspaceSessionEntries(settings);
  const conversationWorkspaceMap =
    remoteConversationWorkspaceBySourceServerId ??
    settings.remoteConversationWorkspaceBySourceServerId;

  if (persistedSessions.length === 0) {
    return;
  }

  const restoredTabs: Array<string | RestorableWorkspaceTab> = [];
  const seenLocalWorkspacePaths = new Set<string>();
  const seenRemoteWorkspaceKeys = new Set<string>();
  // Renderer 恢复导航位置；Host 的本地预热筛选不能决定当前页签，否则远程焦点会丢失。
  const activeSessionIndex = Math.min(
    Math.max(settings.lastActiveTabIndex ?? 0, 0),
    persistedSessions.length - 1,
  );
  let restoredActiveIndex = 0;

  for (const [index, persistedEntry] of persistedSessions.entries()) {
    if (persistedEntry.kind === "local") {
      // 原因：不同 conversation 路径已经是不同任务的文件归属，不能按 purpose 合并到 default。
      // 仅按原身份去重；旧记录缺 lastActiveWorkspace 也保留原路径、purpose 和活动选择。
      if (seenLocalWorkspacePaths.has(persistedEntry.workspacePath)) {
        logger.warn("[Root] 跳过重复的本地 workspace 恢复");
        continue;
      }

      const isConversationWorkspace = persistedEntry.workspacePurpose === "conversation";
      const workspacePurpose = isConversationWorkspace
        ? "conversation"
        : persistedEntry.workspacePurpose;
      const availability =
        !isConversationWorkspace && persistedEntry.workspacePath === unavailableWorkspacePath
          ? "unavailable-local-directory"
          : undefined;
      restoredTabs.push(
        workspacePurpose || availability
          ? {
              workspacePath: persistedEntry.workspacePath,
              workspacePurpose,
              availability,
            }
          : persistedEntry.workspacePath,
      );
      seenLocalWorkspacePaths.add(persistedEntry.workspacePath);
      const restoredIndex = restoredTabs.length - 1;
      if (index === activeSessionIndex) {
        restoredActiveIndex = restoredIndex;
      }
      continue;
    }

    const workspaceIdentity = resolveRemoteWorkspaceSessionIdentity(persistedEntry);
    const workspaceKey = workspaceIdentity?.trim() || persistedEntry.workspacePath;
    const workspacePurpose = resolveRemoteConversationWorkspacePurpose(
      persistedEntry,
      conversationWorkspaceMap,
    );
    // 停用远程无项目 UI 只跳过恢复，不能删除会话数据或 canonical 历史映射。
    if (workspacePurpose === "conversation") continue;
    if (seenRemoteWorkspaceKeys.has(workspaceKey)) {
      logger.warn("[Root] 跳过身份冲突的远程 workspace 恢复");
      continue;
    }

    if (!allowRemoteWorkspaceRestore) {
      // 远程连接入口被策略隐藏时，启动恢复不能悄悄拉起远程 workspace tab。
      // 否则用户看不到入口却仍保留“断连态远程项”，会造成展示与能力不一致。
      continue;
    }

    // 启动只恢复“断开态远程 tab”，不做自动重连。
    // 这样 setting.json 中的 lastConnectionStatus 才能真实反映上次结果，
    // 用户关闭的远端 tab 也不会在下次启动被后台拉回。
    restoredTabs.push({
      workspacePath: persistedEntry.workspacePath,
      remoteTarget: persistedEntry.target,
      workspaceIdentity,
      ...(workspacePurpose ? { workspacePurpose } : {}),
    });
    seenRemoteWorkspaceKeys.add(workspaceKey);
    if (index === activeSessionIndex) {
      restoredActiveIndex = restoredTabs.length - 1;
    }
  }

  if (restoredTabs.length > 0) {
    if (restoreMode === "active-first" && restoredTabs.length > 1) {
      const activeTab = restoredTabs[restoredActiveIndex];
      if (activeTab) {
        const activeWorkspaceKey = getRestorableWorkspaceKey(activeTab);
        logger.info("[Root] 优先恢复 active workspace", {
          deferredCount: restoredTabs.length - 1,
        });
        tabStoreApi.getState().restoreTabs([activeTab], 0);
        return {
          deferredRestore: () => {
            const startupActiveStillOpen = tabStoreApi
              .getState()
              .tabs.filter(isWorkspaceTab)
              .some(
                (tab) =>
                  (tab.workspaceIdentity?.trim() || tab.workspacePath) === activeWorkspaceKey,
              );
            // active-first 保存的是旧 settings 快照；idle callback 前用户若关闭 active tab，
            // 直接 complete 会把它从旧快照复活。关闭属于本窗口新意图，补齐时必须排除该 identity。
            const tabsToComplete = startupActiveStillOpen
              ? restoredTabs
              : restoredTabs.filter(
                  (restoredTab) => getRestorableWorkspaceKey(restoredTab) !== activeWorkspaceKey,
                );
            logger.info("[Root] 首帧后补齐 inactive workspace", {
              count: tabsToComplete.length - (startupActiveStillOpen ? 1 : 0),
            });
            tabStoreApi.getState().completeTabRestore(tabsToComplete);
          },
        };
      }
    }
    logger.info("[Root] 恢复组合 workspace 会话", {
      count: restoredTabs.length,
      activeIndex: restoredActiveIndex,
    });
    tabStoreApi.getState().restoreTabs(restoredTabs, restoredActiveIndex);
  }
  return undefined;
}
