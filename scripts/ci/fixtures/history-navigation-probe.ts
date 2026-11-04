import {
  createTaskNavigationHistory,
  pushNavEntry,
} from "../../../packages/ui/src/lib/taskNavigationHistory.js";
import type { TabStore } from "../../../packages/ui/src/store/tabStore.js";
import { useZCodeSessionStore } from "../../../packages/ui/src/store/zcodeSessionStore.js";
import { useTaskQueryCacheStore } from "../../../packages/ui/src/store/taskQueryCacheStore.js";

const workspacePath = "fixture-workspace";
const workspaceIdentity = "fixture-remote";

export function createHistoryNavigationProbe(tabStore: TabStore) {
  return {
    seed(taskIds: string[], cursor: number, existingTaskIds: string[]) {
      const activeTaskId = taskIds[cursor];
      if (!activeTaskId) throw new Error("E2E_HISTORY_CURSOR_INVALID");
      tabStore.getState().addTab(workspacePath, { workspaceIdentity });
      const session = useZCodeSessionStore.getState();
      session.setActiveTaskId(workspacePath, activeTaskId, workspaceIdentity);
      const workspace = session.getWorkspaceState(workspacePath, workspaceIdentity);
      let history = createTaskNavigationHistory();
      for (const [index, taskId] of taskIds.entries()) {
        // 同身份路径别名会保留两条原始访问记录；必须通过生产入栈函数构造可达重复目标。
        const path = taskIds[index - 1] === taskId ? "fixture-workspace-alias" : workspacePath;
        history = pushNavEntry(history, path, taskId, workspaceIdentity);
      }
      if (history.entries.length !== taskIds.length) throw new Error("E2E_HISTORY_SEED_DEDUPED");
      history = { ...history, cursor };
      useZCodeSessionStore.setState({
        taskNavHistory: history,
        workspaces: {
          ...useZCodeSessionStore.getState().workspaces,
          [workspaceIdentity]: {
            ...workspace,
            activeTaskId,
            modelSwitchPending: false,
            modelSwitchStage: "idle",
          },
        },
      });
      const cache = useTaskQueryCacheStore.getState();
      cache.clearAll();
      for (const taskId of existingTaskIds)
        cache.upsertTaskMeta({
          taskId,
          workspacePath,
          workspaceIdentity,
          traceId: "E2E_NAV_TRACE" as never,
          title: taskId,
          createdAt: 1,
          updatedAt: 1,
          mode: "default",
        });
    },
    snapshot() {
      const state = useZCodeSessionStore.getState();
      return {
        active: state.getWorkspaceState(workspacePath, workspaceIdentity).activeTaskId,
        cursor: state.taskNavHistory.cursor,
        taskIds: state.taskNavHistory.entries.map((entry) =>
          entry.kind === "task" ? entry.taskId : entry.kind,
        ),
      };
    },
  };
}
