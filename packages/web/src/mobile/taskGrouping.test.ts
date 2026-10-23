import { describe, expect, it } from "vitest";
import type { WebRemoteControlTaskRef, WebRemoteControlWorkspaceRef } from "@zcode/shared";
import { groupMobileTasks } from "./taskGrouping.js";

function referenceGroups(
  workspaces: readonly WebRemoteControlWorkspaceRef[],
  tasks: readonly WebRemoteControlTaskRef[],
  organize: "timeline" | "workspace",
  sortBy: "created" | "updated",
) {
  const sorted = [...tasks].sort((a, b) => {
    if (sortBy === "updated") return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
    return (b.createdAt ?? 0) - (a.createdAt ?? 0);
  });
  if (organize === "timeline") return [{ key: "timeline", label: null, tasks: sorted }];
  return workspaces.map((workspace) => ({
    key: workspace.workspaceKey,
    label: workspace.label ?? workspace.workspacePath,
    tasks: sorted.filter((task) => task.workspaceKey === workspace.workspaceKey),
  }));
}

function workspace(key: string, label?: string): WebRemoteControlWorkspaceRef {
  return { workspaceKey: key, workspacePath: `/project/${key}`, kind: "local", label };
}

describe("mobile task grouping work", () => {
  it("preserves order, empty and duplicate groups, exact keys and stable timestamp sorting", () => {
    const workspaces = [workspace("a", ""), workspace("empty"), workspace("a"), workspace(" a ")];
    const tasks: WebRemoteControlTaskRef[] = [
      { workspaceKey: "a", taskId: "first", title: "first", updatedAt: 2, createdAt: 1 },
      { workspaceKey: "a", taskId: "second", title: "second", updatedAt: 2, createdAt: 3 },
      { workspaceKey: "unknown", taskId: "unknown", title: "unknown" },
      { workspaceKey: " a ", taskId: "exact", title: "exact", updatedAt: 1 },
    ];
    Object.freeze(workspaces);
    Object.freeze(tasks);
    for (const organize of ["timeline", "workspace"] as const) {
      for (const sortBy of ["created", "updated"] as const) {
        expect(groupMobileTasks(workspaces, tasks, organize, sortBy)).toEqual(
          referenceGroups(workspaces, tasks, organize, sortBy),
        );
      }
    }
    const groups = groupMobileTasks(workspaces, tasks, "workspace", "updated");
    expect(groups.map(({ key }) => key)).toEqual(["a", "empty", "a", " a "]);
    expect(groups[0]!.label).toBe("");
    expect(groups[1]!.tasks).toEqual([]);
    expect(groups[0]!.tasks[0]).toBe(tasks[0]);
    expect(groups[0]!.tasks).not.toBe(groups[2]!.tasks);
    groups[0]!.tasks.pop();
    expect(groups[2]!.tasks).toHaveLength(2);
    expect(groupMobileTasks([], tasks, "workspace", "updated")).toEqual([]);
    expect(groupMobileTasks([], [], "timeline", "updated")).toEqual([
      { key: "timeline", label: null, tasks: [] },
    ]);
  });

  it("matches the original grouping for generated immutable bootstrap arrays", () => {
    let seed = 0x73510249;
    const random = () => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed;
    };
    for (let sample = 0; sample < 120; sample++) {
      const workspaces = Array.from({ length: random() % 40 }, () =>
        Object.freeze(workspace(`w${random() % 30}`)),
      );
      const tasks = Array.from({ length: random() % 250 }, (_, i) =>
        Object.freeze({
          workspaceKey: `w${random() % 40}`,
          taskId: `t${i}`,
          title: `task ${i}`,
          ...(random() % 3 ? { updatedAt: random() % 20 } : {}),
          ...(random() % 3 ? { createdAt: random() % 20 } : {}),
        }),
      );
      Object.freeze(workspaces);
      Object.freeze(tasks);
      for (const organize of ["timeline", "workspace"] as const) {
        for (const sortBy of ["created", "updated"] as const) {
          expect(groupMobileTasks(workspaces, tasks, organize, sortBy)).toEqual(
            referenceGroups(workspaces, tasks, organize, sortBy),
          );
        }
      }
    }
  });

  it("reads each task workspace key once instead of once per workspace", () => {
    const workspaces = Array.from({ length: 48 }, (_, i) => workspace(`w${i}`));
    let visits = 0;
    const tasks: WebRemoteControlTaskRef[] = Array.from({ length: 1_440 }, (_, i) => ({
      get workspaceKey() {
        visits++;
        return `w${i % 48}`;
      },
      taskId: `t${i}`,
      title: `task ${i}`,
      updatedAt: i,
    }));
    const expected = referenceGroups(workspaces, tasks, "workspace", "updated");
    expect(visits).toBe(69_120);
    visits = 0;
    const actual = groupMobileTasks(workspaces, tasks, "workspace", "updated");
    const newVisits = visits;
    expect(actual.map(({ tasks: group }) => group.map(({ taskId }) => taskId))).toEqual(
      expected.map(({ tasks: group }) => group.map(({ taskId }) => taskId)),
    );
    expect(newVisits).toBe(1_440);
  });
});
