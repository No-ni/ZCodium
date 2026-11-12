import type {
  WebRemoteControlBootstrapResult,
  WebRemoteControlBridgeDescriptor,
  WebRemoteControlWorkspaceRef,
} from "@zcode/shared";
import type { MobileRootNavigation } from "../contract.js";

export function matchesMobileWorkspace(
  descriptor: Pick<
    WebRemoteControlBridgeDescriptor,
    "workspaceKey" | "workspacePath" | "workspaceIdentity" | "kind" | "remoteSessionId"
  >,
  workspace: WebRemoteControlWorkspaceRef,
): boolean {
  return (
    descriptor.workspaceKey === workspace.workspaceKey &&
    descriptor.workspacePath === workspace.workspacePath &&
    descriptor.kind === workspace.kind &&
    descriptor.remoteSessionId === workspace.remoteSessionId &&
    (descriptor.workspaceIdentity?.trim() || descriptor.workspacePath) === workspace.workspaceKey &&
    (workspace.workspaceIdentity?.trim() || workspace.workspacePath) === workspace.workspaceKey
  );
}

export function mobileWorkspace(
  bootstrap: WebRemoteControlBootstrapResult | null,
  key?: string,
): WebRemoteControlWorkspaceRef | undefined {
  return bootstrap?.workspaces.find((workspace) => workspace.workspaceKey === key);
}

export function initialMobileRootNavigation(
  bootstrap: WebRemoteControlBootstrapResult,
): MobileRootNavigation | null {
  const saved = bootstrap.mobileViewState ?? bootstrap.initialViewState;
  const requested = mobileWorkspace(bootstrap, saved?.activeWorkspaceKey);
  const workspace =
    requested ??
    bootstrap.workspaces.find(
      (candidate) => candidate.kind !== "remote" || candidate.connectionState === "connected",
    );
  if (!workspace) return null;
  const taskId =
    requested &&
    saved?.activeTaskId &&
    bootstrap.tasks.some(
      (task) => task.workspaceKey === workspace.workspaceKey && task.taskId === saved.activeTaskId,
    )
      ? saved.activeTaskId
      : undefined;
  return { workspaceKey: workspace.workspaceKey, taskId, revision: 0 };
}
