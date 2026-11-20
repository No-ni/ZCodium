import type { ProjectSidebarProps } from "./contract.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { taskGroupKey } from "./grouped-view.js";
export function createProjectTaskStarter(
  props: ProjectSidebarProps,
  view: string,
  groups: { parents: ReadonlyMap<string, string> },
) {
  return async (projectId?: string, hostId?: string, taskGroupId?: string | null) => {
    const activeTaskId = useZCodeSessionStore
      .getState()
      .getWorkspaceState(props.workspacePath, props.workspaceIdentity).activeTaskId;
    const inheritedGroup =
      view === "grouped" && !projectId && activeTaskId
        ? (groups.parents.get(
            taskGroupKey({
              taskId: activeTaskId,
              workspacePath: props.workspacePath,
              workspaceIdentity: props.workspaceIdentity,
            }),
          ) ?? null)
        : view === "grouped" && !projectId
          ? (useZCodeSessionStore
              .getState()
              .getWorkspaceState(props.workspacePath, props.workspaceIdentity).draftTaskGroupId ??
            null)
          : null;
    props.onCreateTask({
      projectId: projectId ?? null,
      taskGroupId: taskGroupId === undefined ? inheritedGroup : taskGroupId,
      ...(hostId ? { hostId } : {}),
    });
  };
}
