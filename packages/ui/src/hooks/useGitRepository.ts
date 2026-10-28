import { useEffect, useMemo, useRef, useState } from "react";
import type { IGitService } from "@zcode/services";
import { logger } from "@/logger.js";
import { shouldEnableWorkspaceRpc } from "@/lib/workspaceRpcAvailability.js";
import { useServices } from "@/hooks/useServices.js";
import { useResolvedRemoteWorkspaceSessionId } from "@/hooks/useResolvedRemoteWorkspaceSessionId.js";
import {
  buildLastTurnDataset,
  buildRepositoryDatasets,
  buildSourceOptions,
  createInitialState,
  EMPTY_BRANCH_COMPARISON,
  EMPTY_IDENTITY,
  type GitPaneRepositoryState,
} from "./gitRepositoryState.js";

export type {
  GitPaneFileChange,
  GitPaneSection,
  GitPaneDataset,
  GitPaneSourceOption,
  GitPaneRepositoryState,
} from "./gitRepositoryState.js";

interface GitRepositorySource {
  gitService: IGitService;
  remoteSessionId: string | null;
  workspacePath: string;
  workspaceKey: string;
}
interface GitLiveDataRefreshInput extends GitRepositorySource {
  includeExtendedData: boolean;
  refreshToken: string | number | boolean | null;
  workspaceRpcEnabled: boolean;
}
function isSameRepositorySource(previous: GitRepositorySource, next: GitRepositorySource): boolean {
  // 同 identity 的 attachment 仍会换 proxy；只比路径会吞掉新查询，并泄漏旧 Host 的 watcher 路径。
  return (
    previous.gitService === next.gitService &&
    previous.remoteSessionId === next.remoteSessionId &&
    previous.workspacePath === next.workspacePath &&
    previous.workspaceKey === next.workspaceKey
  );
}
function shouldRefreshLiveGitData(
  previous: GitLiveDataRefreshInput | null,
  next: GitLiveDataRefreshInput,
): boolean {
  if (!next.workspaceRpcEnabled) return false;
  if (!previous || !previous.workspaceRpcEnabled || !isSameRepositorySource(previous, next))
    return true;
  if (previous.refreshToken !== next.refreshToken) return true;
  // 关闭 Git pane 不反向补读扩展数据；task 切换继续只重组本地投影。
  return !previous.includeExtendedData && next.includeExtendedData;
}
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name || String(error);
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return String(error);
}

export function useGitRepository(options: {
  workspacePath: string;
  activeTaskId: string | null;
  includeExtendedData?: boolean;
  refreshToken?: string | number | boolean | null;
  remoteSessionId?: string | null;
  remoteTarget?: unknown;
  workspaceIdentity?: string | null;
}): GitPaneRepositoryState {
  const {
    workspacePath,
    includeExtendedData = false,
    refreshToken = null,
    remoteSessionId: preferredRemoteSessionId = null,
    remoteTarget,
    workspaceIdentity = null,
  } = options;
  const { gitService } = useServices();
  const remoteSessionId = useResolvedRemoteWorkspaceSessionId(
    workspacePath,
    preferredRemoteSessionId,
    workspaceIdentity,
    remoteTarget,
  );
  const workspaceRpcEnabled = shouldEnableWorkspaceRpc({
    workspaceIdentity,
    remoteSessionId,
    remoteTarget,
  });
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const source: GitRepositorySource = { gitService, remoteSessionId, workspacePath, workspaceKey };
  // 结果与来源共用一个 state owner，不另存“当前 service”状态或复制快照。
  const [repository, setRepository] = useState(() => ({
    ...source,
    state: createInitialState(workspacePath, { workspaceKey }),
  }));
  const requestVersionRef = useRef(0);
  const lastLiveRefreshInputRef = useRef<GitLiveDataRefreshInput | null>(null);

  useEffect(
    () => () => {
      // 卸载才终结此 hook owner；关 pane 的 effect cleanup 不能作废同来源在途的扩展 superset。
      requestVersionRef.current += 1;
      lastLiveRefreshInputRef.current = null;
    },
    [],
  );

  useEffect(() => {
    const requestSource: GitRepositorySource = {
      gitService,
      remoteSessionId,
      workspacePath,
      workspaceKey,
    };
    const nextRefreshInput = {
      ...requestSource,
      includeExtendedData,
      refreshToken,
      workspaceRpcEnabled,
    };
    if (!workspaceRpcEnabled) {
      requestVersionRef.current += 1;
      lastLiveRefreshInputRef.current = nextRefreshInput;
      setRepository((current) => ({
        ...requestSource,
        state: createInitialState(workspacePath, {
          workspaceKey,
          loading: false,
          revision: current.state.revision,
        }),
      }));
      return;
    }
    const shouldRefresh = shouldRefreshLiveGitData(
      lastLiveRefreshInputRef.current,
      nextRefreshInput,
    );
    lastLiveRefreshInputRef.current = nextRefreshInput;
    if (!shouldRefresh) return;
    const requestVersion = ++requestVersionRef.current;
    setRepository((current) => ({
      ...requestSource,
      state: isSameRepositorySource(current, requestSource)
        ? { ...current.state, loading: true, error: null }
        : createInitialState(workspacePath, { workspaceKey }),
    }));
    // 仍只走一次 refresh，避免 summary/staged/unstaged 各自重复 git status。
    void gitService
      .refresh({
        workspacePath,
        includeIdentity: includeExtendedData,
        includeBranchComparison: includeExtendedData,
      })
      .then(({ summary, identity, unstagedChanges, stagedChanges, branchComparison }) => {
        if (requestVersionRef.current !== requestVersion) return;
        const datasets = {
          ...buildRepositoryDatasets({
            unstagedChanges,
            stagedChanges,
            branchComparison: branchComparison ?? EMPTY_BRANCH_COMPARISON,
          }),
          // 旧 per-turn store 写入链路已移除，继续保留上一轮数据集的同一空态投影。
          "last-turn": buildLastTurnDataset({
            workspacePath,
            turnIndex: null,
            fileChange: null,
            summary: null,
          }),
        };
        setRepository({
          ...requestSource,
          state: {
            workspaceKey,
            summary,
            identity: identity ?? EMPTY_IDENTITY,
            placeholder: { enabled: false },
            loading: false,
            error: null,
            revision: requestVersion,
            sourceOptions: buildSourceOptions(datasets),
            datasets,
          },
        });
      })
      .catch((error: unknown) => {
        // 旧 attachment 的失败同样属于旧来源，不能结束新请求的 loading 或覆盖其错误。
        if (requestVersionRef.current !== requestVersion) return;
        const message = getErrorMessage(error);
        logger.warn("[useGitRepository] 读取 Git 仓库状态失败", { workspacePath, error: message });
        setRepository((current) => ({
          ...requestSource,
          state: createInitialState(workspacePath, {
            workspaceKey,
            loading: false,
            error: message,
            revision: current.state.revision,
          }),
        }));
      });
  }, [
    gitService,
    remoteSessionId,
    includeExtendedData,
    refreshToken,
    workspaceKey,
    workspacePath,
    workspaceRpcEnabled,
  ]);

  // effect 换代前就拒绝旧来源，防止新 service 在首帧注册旧 Host 的 watcher 路径。
  return useMemo(
    () =>
      isSameRepositorySource(repository, {
        gitService,
        remoteSessionId,
        workspacePath,
        workspaceKey,
      })
        ? repository.state
        : createInitialState(workspacePath, { workspaceKey, loading: workspaceRpcEnabled }),
    [repository, gitService, remoteSessionId, workspacePath, workspaceKey, workspaceRpcEnabled],
  );
}
