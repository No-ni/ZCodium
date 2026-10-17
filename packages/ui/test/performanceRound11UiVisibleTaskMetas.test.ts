import { describe, expect, it } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { mergeTaskWithOptimisticMeta } from "@/lib/zcodeTaskMetaMerge.js";
import { getVisibleTaskMetas } from "@/store/zcodeSessionStoreSelectors.js";

type TaskMetaFields = Partial<
  Omit<
    ZCodeTaskMeta,
    "taskId" | "traceId" | "title" | "workspacePath" | "createdAt" | "updatedAt" | "mode"
  >
>;

function createTaskMeta(
  taskId: string,
  title: string,
  updatedAt: number,
  fields: TaskMetaFields = {},
): ZCodeTaskMeta {
  return {
    taskId,
    traceId: `trace-${taskId}`,
    title,
    workspacePath: "/repo",
    createdAt: 1,
    updatedAt,
    mode: "edit",
    ...fields,
  };
}

function trackTaskIdReads(task: ZCodeTaskMeta, onRead: () => void): ZCodeTaskMeta {
  const taskId = task.taskId;
  Object.defineProperty(task, "taskId", {
    configurable: true,
    enumerable: true,
    get() {
      onRead();
      return taskId;
    },
  });
  return task;
}

describe("getVisibleTaskMetas performance round 11", () => {
  it("preserves visible ordering and first-cache optimistic merge semantics", () => {
    const duplicateFirst = createTaskMeta("duplicate", "First duplicate", 1, {
      status: "running",
    });
    const stableFirst = createTaskMeta("stable", "Stable first", 4, {
      status: "completed",
    });
    const duplicateLast = createTaskMeta("duplicate", "Last duplicate", 10, {
      status: "completed",
    });
    const stableLast = createTaskMeta("stable", "Stable last", 8);
    const cached = createTaskMeta("cached", "Cached title", 20, {
      status: "running",
    });
    const cachedOptimistic = createTaskMeta("cached", "Older optimistic", 2, {
      provider: "glm",
    });
    const duplicateOptimisticLast = createTaskMeta("duplicate", "Optimistic last", 30, {
      model: "glm-model",
    });
    const optimisticOnly = createTaskMeta("missing", "Optimistic only", 3);
    const taskListCache = Object.freeze([
      duplicateFirst,
      stableFirst,
      duplicateLast,
      stableLast,
      cached,
    ]);
    const optimisticTaskListByTaskId = Object.freeze({
      duplicate: duplicateOptimisticLast,
      cached: cachedOptimistic,
      missing: optimisticOnly,
    });

    const visible = getVisibleTaskMetas({ taskListCache, optimisticTaskListByTaskId });

    expect(visible.map((task) => task.taskId)).toEqual([
      "duplicate",
      "stable",
      "cached",
      "missing",
    ]);
    expect(visible).toEqual([
      mergeTaskWithOptimisticMeta(duplicateFirst, duplicateOptimisticLast),
      stableLast,
      mergeTaskWithOptimisticMeta(cached, cachedOptimistic),
      optimisticOnly,
    ]);
    expect(visible[0]).toMatchObject({
      title: "Optimistic last",
      status: "running",
      model: "glm-model",
    });
    expect(visible[1]).toBe(stableLast);
    expect(visible[2]).toMatchObject({
      title: "Cached title",
      status: "running",
      provider: "glm",
    });
    expect(visible[3]).toBe(optimisticOnly);
    expect(taskListCache[0]).toBe(duplicateFirst);
    expect(taskListCache[2]).toBe(duplicateLast);
    expect(optimisticTaskListByTaskId.duplicate).toBe(duplicateOptimisticLast);
  });

  it("keeps task IDs isolated across workspace state inputs", () => {
    const localTask = createTaskMeta("shared-id", "Local title", 1);
    const remoteTask = createTaskMeta("shared-id", "Remote title", 1, {
      workspaceIdentity: "ssh://host/repo",
    });

    const localVisible = getVisibleTaskMetas({ taskListCache: [localTask] });
    const remoteVisible = getVisibleTaskMetas({ taskListCache: [remoteTask] });

    expect(localVisible).toEqual([localTask]);
    expect(remoteVisible).toEqual([remoteTask]);
    expect(localVisible[0]).not.toBe(remoteVisible[0]);
  });

  it("keeps cache taskId reads linear for many optimistic overrides", () => {
    const cacheCount = 512;
    const optimisticCount = 256;
    let cacheTaskIdReads = 0;
    const taskListCache = Array.from({ length: cacheCount }, (_, index) =>
      trackTaskIdReads(createTaskMeta(`task-${index}`, `Cached ${index}`, index), () => {
        cacheTaskIdReads += 1;
      }),
    );
    const optimisticTaskListByTaskId = Object.fromEntries(
      Array.from({ length: optimisticCount }, (_, offset) => {
        const index = cacheCount - optimisticCount + offset;
        return [
          `task-${index}`,
          createTaskMeta(`task-${index}`, `Optimistic ${index}`, cacheCount + index),
        ];
      }),
    );

    const visible = getVisibleTaskMetas({ taskListCache, optimisticTaskListByTaskId });

    expect(visible).toHaveLength(cacheCount);
    expect(visible[cacheCount - optimisticCount]).toMatchObject({
      taskId: `task-${cacheCount - optimisticCount}`,
      title: `Optimistic ${cacheCount - optimisticCount}`,
    });
    expect(cacheTaskIdReads).toBe(cacheCount);
  });
});
