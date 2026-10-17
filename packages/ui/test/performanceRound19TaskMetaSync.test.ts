import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { buildTaskEntityKey, buildTaskListCacheDescriptor } from "@/lib/taskQueryCache.js";
import { syncTaskMetaToTaskCaches } from "@/lib/taskListMetaSync.js";
import { useTaskQueryCacheStore as store } from "@/store/taskQueryCacheStore.js";

// 真实同步函数和 query store；workspace/optimistic 端注入内存状态，不加载用户持久化资料。
const workspace = vi.hoisted(() => ({
  tasks: [] as ZCodeTaskMeta[],
  optimistic: new Map<string, ZCodeTaskMeta>(),
}));
vi.mock("@/store/zcodeSessionStore.js", () => ({
  getTaskMeta: (_state: unknown, taskId: string) =>
    workspace.optimistic.get(taskId) ?? workspace.tasks.find((task) => task.taskId === taskId),
  useZCodeSessionStore: {
    getState: () => ({
      getWorkspaceState: () => ({ taskListCache: workspace.tasks }),
      setTaskListCache: (_path: string, tasks: ZCodeTaskMeta[]) => {
        workspace.tasks = tasks;
      },
      upsertOptimisticTaskListItem: (_path: string, task: ZCodeTaskMeta) => {
        workspace.optimistic.set(task.taskId, task);
      },
    }),
  },
}));

function task(id: string, updatedAt: number): ZCodeTaskMeta {
  return {
    taskId: id,
    traceId: `synthetic-${id}`,
    title: `Task ${id}`,
    mode: "edit",
    workspacePath: "C:/synthetic/workspace",
    createdAt: 1,
    updatedAt,
  };
}

function sync(task: ZCodeTaskMeta) {
  syncTaskMetaToTaskCaches({
    workspacePath: task.workspacePath,
    task,
    membership: { pinned: false, archived: false },
    ensureInWorkspaceTaskCache: true,
  });
}

const cleanups: Array<() => void> = [];
beforeEach(() => {
  store.getState().clearAll();
  workspace.optimistic.clear();
  workspace.tasks = [task("first", 20), task("second", 10)];
  store.getState().setQueryResult({
    queryKey: "visible",
    descriptor: buildTaskListCacheDescriptor({
      kind: "workspace",
      sortBy: "updated",
      expanded: true,
      workspaceScopes: [{ workspacePath: "C:/synthetic/workspace" }],
    }),
    items: workspace.tasks,
    total: 2,
    hasMore: false,
  });
  sync(workspace.tasks[0]!);
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  store.getState().clearAll();
  workspace.tasks = [];
  workspace.optimistic.clear();
});

describe("real task metadata sync pipeline", () => {
  it("publishes no query-cache changes for forty equivalent incoming events", () => {
    const current = workspace.tasks[0]!;
    const before = store.getState();
    let publications = 0;
    cleanups.push(
      store.subscribe(() => {
        publications += 1;
      }),
    );
    for (let index = 0; index < 40; index += 1) sync({ ...current });
    expect(publications).toBe(0);
    expect(store.getState()).toBe(before);
    expect(workspace.tasks).toHaveLength(2);
  });

  it("publishes an actual title update once and preserves the unchanged query", () => {
    const current = workspace.tasks[0]!;
    const before = store.getState();
    let publications = 0;
    cleanups.push(
      store.subscribe(() => {
        publications += 1;
      }),
    );
    sync({ ...current, title: "Changed title", updatedAt: 21 });
    expect(publications).toBe(1);
    expect(store.getState().taskMetaByEntityKey[buildTaskEntityKey(current)]!.title).toBe(
      "Changed title",
    );
    expect(store.getState().resultsByQueryKey).toBe(before.resultsByQueryKey);
    expect(workspace.optimistic.get(current.taskId)!.title).toBe("Changed title");
  });

  it("reorders after upsert through the real mutation branch without changing total", () => {
    const first = workspace.tasks[0]!;
    const second = workspace.tasks[1]!;
    sync({ ...second, updatedAt: 30 });
    expect(store.getState().resultsByQueryKey.visible).toMatchObject({
      taskKeys: [buildTaskEntityKey(second), buildTaskEntityKey(first)],
      total: 2,
      hasMore: false,
    });
    expect(store.getState().taskMetaByEntityKey[buildTaskEntityKey(second)]!.updatedAt).toBe(30);
  });
});
