import type { WebRemoteControlTaskRef, WebRemoteControlWorkspaceRef } from "@zcode/shared";

export function groupMobileTasks(
  workspaces: readonly WebRemoteControlWorkspaceRef[],
  tasks: readonly WebRemoteControlTaskRef[],
  organize: "timeline" | "workspace",
  sortBy: "created" | "updated",
): Array<{ key: string; label: string | null; tasks: WebRemoteControlTaskRef[] }> {
  const sorted = [...tasks].sort((a, b) => {
    if (sortBy === "updated") return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
    return (b.createdAt ?? 0) - (a.createdAt ?? 0);
  });
  if (organize === "timeline") return [{ key: "timeline", label: null, tasks: sorted }];
  if (workspaces.length === 0) return [];
  // 原分组每个工作区都重扫全部任务；单次分桶保留稳定排序，各组仍返回独立数组。
  const tasksByWorkspace = new Map<string, WebRemoteControlTaskRef[]>();
  for (const task of sorted) {
    const key = task.workspaceKey;
    const group = tasksByWorkspace.get(key);
    if (group) group.push(task);
    else tasksByWorkspace.set(key, [task]);
  }
  return workspaces.map((workspace) => ({
    key: workspace.workspaceKey,
    label: workspace.label ?? workspace.workspacePath,
    tasks: [...(tasksByWorkspace.get(workspace.workspaceKey) ?? [])],
  }));
}
