import { describe, expect, it, vi } from "vitest";
import type { IZCodeTaskService, ZCodeTaskListWorkspaceScope } from "@zcode/services";
import type { WindowHostControllerTaskRow } from "@zcode/shared/zcode-protocol-v4";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { createWindowHostControllerRuntime } from "./windowHostControllerService.js";
import type { WindowHostControllerSourceScope } from "./windowHostControllerProjection.js";

function meta(taskId: string, overrides: Partial<ZCodeTaskMeta> = {}): ZCodeTaskMeta {
  return {
    taskId,
    traceId: "fixture",
    title: taskId,
    mode: "build",
    provider: "glm",
    workspacePath: "/workspace",
    createdAt: 1,
    updatedAt: 1,
    status: "completed",
    ...overrides,
  };
}

function service(tasks: () => ZCodeTaskMeta[], search: () => Promise<ZCodeTaskMeta[]>) {
  return {
    listTasks: async () => tasks(),
    listPinnedTasks: async () => [],
    listArchivedTasks: async () => [],
    listTaskList: async () => {
      const items = await search();
      return { items, total: items.length, hasMore: false };
    },
  } as unknown as IZCodeTaskService;
}

describe("controller search projection work", () => {
  it("sorts the complete task projection once per non-empty search response", async () => {
    const tasks = Array.from({ length: 96 }, (_, i) => meta(`t${i}`, { updatedAt: i }));
    const scope = { kind: "local" as const, workspacePath: "/workspace" };
    const runtime = createWindowHostControllerRuntime({
      createId: () => "fixture",
      resolveSource: () => ({
        scope,
        taskService: service(
          () => tasks,
          async () => tasks,
        ),
        sourceAvailability: "online",
      }),
    });
    const original = Array.prototype.sort;
    let projectionSorts = 0;
    const spy = vi
      .spyOn(Array.prototype, "sort")
      .mockImplementation(function (this: WindowHostControllerTaskRow[], compare) {
        if (this.length && this[0]?.address && this[0]?.meta) projectionSorts++;
        return original.call(this, compare);
      });
    let result;
    try {
      result = await runtime.service.listTaskList({
        workspaceScopes: [scope],
        kind: "active",
        search: "fixture",
        sortBy: "updated",
        limit: 7,
      });
    } finally {
      spy.mockRestore();
      runtime.dispose();
    }
    expect(result.items).toHaveLength(7);
    expect(result.total).toBe(96);
    expect(result.hasMore).toBe(true);
    expect(result.items[0]!.taskId).toBe("t95");
    expect(projectionSorts).toBe(1);
  });

  it("reads refreshed projection after the response and keeps source addresses isolated", async () => {
    const local: WindowHostControllerSourceScope = { kind: "local", workspacePath: "/workspace" };
    const remote: WindowHostControllerSourceScope = {
      kind: "remote",
      workspacePath: "/workspace",
      workspaceIdentity: "remote-identity",
      remoteSessionId: "current",
    };
    let localTasks = [meta("shared", { title: "local initial", updatedAt: 2 })];
    const remoteTasks = [
      meta("shared", {
        title: "remote projection",
        updatedAt: 3,
        workspaceIdentity: "remote-identity",
      }),
    ];
    let release!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const localService = service(
      () => localTasks,
      async () => {
        entered();
        await pending;
        return [
          { ...meta("shared", { title: "stale search" }), searchSnippets: ["matching text"] },
          meta("fallback", { title: "fallback", updatedAt: 4 }),
        ];
      },
    );
    const remoteService = service(
      () => remoteTasks,
      async () => [meta("shared", { title: "remote search" })],
    );
    const runtime = createWindowHostControllerRuntime({
      createId: () => "fixture",
      resolveSource: (scope: ZCodeTaskListWorkspaceScope) =>
        scope.workspaceIdentity
          ? { scope: remote, taskService: remoteService, sourceAvailability: "online" }
          : { scope: local, taskService: localService, sourceAvailability: "online" },
    });
    try {
      const search = runtime.service.listTaskList({
        workspaceScopes: [local, remote],
        kind: "active",
        search: "fixture",
        sortBy: "updated",
      });
      await started;
      localTasks = [meta("shared", { title: "local refreshed", updatedAt: 8, status: "error" })];
      await runtime.refreshWorkspace(local);
      release();
      const result = await search;
      expect(result.items.map(({ title }) => title)).toEqual([
        "local refreshed",
        "fallback",
        "remote projection",
      ]);
      expect(result.items[0]!.liveStatus).toBe("error");
      expect(result.items[0]!.searchSnippets).toEqual(["matching text"]);
      expect(result.items[2]!.remoteSessionId).toBe("current");
      expect(result.items[2]!.workspaceIdentity).toBe("remote-identity");
      expect(result.items[0]!.remoteSessionId).toBeUndefined();
    } finally {
      release();
      runtime.dispose();
    }
  });
});
