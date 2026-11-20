import type { ProjectTree } from "./contract.js";
import { buildRemoteHostWorkspaceIdentity } from "./contract.js";
import { isWorkspaceTab, type WindowTabState } from "@/store/tabStore.js";
export function projectObservationScopes(
  tree: ProjectTree,
  tabs: WindowTabState[],
  registry: boolean,
) {
  const byKey = new Map<string, { workspacePath: string; workspaceIdentity?: string }>();
  for (const task of tree.tasks) byKey.set(task.workspaceIdentity || task.workspacePath, task);
  for (const project of tree.projects)
    for (const root of project.roots) {
      const identity =
        registry && project.hostId !== "local"
          ? buildRemoteHostWorkspaceIdentity(project.hostId, root.rootPath)
          : undefined;
      byKey.set(identity || root.rootPath, {
        workspacePath: root.rootPath,
        ...(identity ? { workspaceIdentity: identity } : {}),
      });
    }
  for (const tab of tabs)
    if (isWorkspaceTab(tab) && !tab.workspaceIdentity && !tab.remoteSessionId)
      byKey.set(tab.workspacePath, { workspacePath: tab.workspacePath });
  return [...byKey.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, { workspacePath, workspaceIdentity }]) => ({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
    }));
}
