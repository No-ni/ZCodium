import { useEffect, useMemo, useRef, useState } from "react";
import type { WebRemoteControlStatusSnapshot } from "@zcode/shared";
import { usePlatform } from "./usePlatform.js";
import { useGlobalTaskList } from "./useGlobalTaskList.js";
import { buildWebRemoteControlSyncPayload } from "@/lib/webRemoteControlSync.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { logger } from "@/logger.js";

const EMPTY_WORKSPACES: WorkspaceTabState[] = [];

/** 窗口级同步唯一入口：远控运行时保活，生命周期不再依赖二维码弹窗。 */
export function useWebRemoteControlWindowSync(params: {
  enabled: boolean;
  workspaceTabs: WorkspaceTabState[];
}): void {
  const platform = usePlatform();
  const [statusSnapshot, setStatusSnapshot] = useState<WebRemoteControlStatusSnapshot>({
    status: "idle",
  });
  const running = ["starting", "running", "connecting", "active"].includes(statusSnapshot.status);
  const sessionId = statusSnapshot.sessionId;
  const sendChain = useRef(Promise.resolve());
  useEffect(() => {
    if (!params.enabled) return;
    let cancelled = false;
    let receivedStatus = false;
    const accept = (snapshot: WebRemoteControlStatusSnapshot) => {
      if (cancelled) return;
      setStatusSnapshot(snapshot);
    };
    const dispose = platform.onWebRemoteControlStatusChanged?.((snapshot) => {
      receivedStatus = true;
      accept(snapshot);
    });
    void platform
      .getWebRemoteControlStatus()
      .then((snapshot) => {
        if (!receivedStatus) accept(snapshot);
      })
      .catch((error) => logger.warn("[web-remote-control] 读取窗口远控状态失败", error));
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [params.enabled, platform]);

  const workspaces = params.enabled && running ? params.workspaceTabs : EMPTY_WORKSPACES;
  // active 包含所有未归档任务及置顶项，沿用侧栏共享 Controller 订阅和查询缓存。
  const { items, loading } = useGlobalTaskList({
    enabled: params.enabled && running,
    kind: "active",
    workspaceTabs: workspaces,
    sortBy: "updated",
    searchQuery: "",
    expanded: true,
    collapsedLimit: 0,
  });
  const payload = useMemo(
    () => buildWebRemoteControlSyncPayload(workspaces, items),
    [workspaces, items],
  );

  useEffect(() => {
    if (!params.enabled || !running || loading || !sessionId) return;
    const target =
      payload.workspaces[0] ??
      params.workspaceTabs[0] ??
      (statusSnapshot.workspacePath
        ? {
            workspacePath: statusSnapshot.workspacePath,
            workspaceIdentity: statusSnapshot.workspaceIdentity,
          }
        : null);
    if (!target) return;
    let cancelled = false;
    // 两次平台写必须串行；更新/停止后的旧 payload 不得晚于新 scope 覆盖 Main 清单。
    sendChain.current = sendChain.current
      .catch(() => {})
      .then(async () => {
        if (cancelled) return;
        const scope = {
          workspacePath: target.workspacePath,
          workspaceIdentity: target.workspaceIdentity,
        };
        await platform.syncWebRemoteControlWorkspaces({ ...scope, workspaces: payload.workspaces });
        if (cancelled) return;
        await platform.syncWebRemoteControlTasks({ ...scope, tasks: payload.tasks });
      })
      .catch((error) => {
        if (!cancelled) logger.warn("[web-remote-control] 同步窗口任务清单失败", error);
      });
    return () => {
      cancelled = true;
    };
  }, [
    params.enabled,
    params.workspaceTabs,
    running,
    sessionId,
    loading,
    payload,
    platform,
    statusSnapshot.workspacePath,
    statusSnapshot.workspaceIdentity,
  ]);
}
