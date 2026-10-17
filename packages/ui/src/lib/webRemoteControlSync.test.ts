import { describe, expect, it } from "vitest";
import { buildWebRemoteControlSyncPayload } from "./webRemoteControlSync.js";
import type { WindowHostControllerTaskListItem } from "@zcode/services";
import { webRemoteControlTaskSyncSchema, webRemoteControlWorkspaceSyncSchema } from "@zcode/shared";

describe("手机清单投影", () => {
  it("覆盖所有窗口工作区，按 identity 隔离同路径，并采信 Controller liveStatus", () => {
    const workspaces = [
      { workspacePath: "/fixture", label: "local" },
      {
        workspacePath: "/fixture",
        workspaceIdentity: "fixture-remote",
        remoteSessionId: "remote-A",
        label: "remote",
      },
    ];
    const tasks = [
      {
        taskId: "pinned-task",
        workspacePath: "/fixture",
        title: "置顶任务",
        status: "completed",
        liveStatus: "running",
        createdAt: 1,
        updatedAt: 2,
      },
      {
        taskId: "remote-task",
        workspacePath: "/fixture",
        workspaceIdentity: "fixture-remote",
        remoteSessionId: "remote-A",
        title: "远程任务",
        liveStatus: "waiting",
        createdAt: 1,
        updatedAt: 3,
      },
      { taskId: "outside", workspacePath: "/outside", title: "其他窗口", liveStatus: "running" },
    ] as WindowHostControllerTaskListItem[];
    const payload = buildWebRemoteControlSyncPayload(workspaces, tasks);
    expect(payload.workspaces).toHaveLength(2);
    expect(payload.tasks.map((task) => task.taskId)).toEqual(["pinned-task", "remote-task"]);
    expect(payload.tasks.map((task) => task.displayStatus)).toEqual(["running", "running"]);
    expect(payload.tasks[1]).toMatchObject({
      workspaceKey: "fixture-remote",
      remoteSessionId: "remote-A",
    });
    expect(
      webRemoteControlTaskSyncSchema.safeParse({ workspacePath: "/fixture", tasks: payload.tasks })
        .success,
    ).toBe(true);
    expect(
      webRemoteControlWorkspaceSyncSchema.safeParse({
        workspacePath: "/fixture",
        workspaces: payload.workspaces,
      }).success,
    ).toBe(true);
  });

  it("remote session 换代丢弃旧 session 的任务，重复 tab 仅发布一个 workspace", () => {
    const workspace = {
      workspacePath: "/fixture",
      workspaceIdentity: "fixture-remote",
      remoteSessionId: "remote-B",
    };
    const tasks = [
      { taskId: "old", ...workspace, remoteSessionId: "remote-A" },
    ] as WindowHostControllerTaskListItem[];
    const payload = buildWebRemoteControlSyncPayload([workspace, workspace], tasks);
    expect(payload.workspaces).toHaveLength(1);
    expect(payload.tasks).toEqual([]);
  });
});
