import type {
  WebRemoteControlBootstrapResult,
  WindowProjectDirectorySnapshot,
} from "@zcode/shared";

export function mergeMobileWindowDirectory(
  bootstrap: WebRemoteControlBootstrapResult,
  directory: WindowProjectDirectorySnapshot,
): WebRemoteControlBootstrapResult {
  const byKey = new Map(
    directory.workspaces.map((workspace) => [workspace.workspaceKey, workspace]),
  );
  return {
    ...bootstrap,
    workspaces: bootstrap.workspaces.map((workspace) => {
      const projected = byKey.get(workspace.workspaceKey);
      if (
        !projected ||
        projected.workspacePath !== workspace.workspacePath ||
        projected.workspaceIdentity !== workspace.workspaceIdentity ||
        projected.remoteSessionId !== workspace.remoteSessionId ||
        projected.kind !== workspace.kind
      )
        return workspace;
      return {
        ...workspace,
        ...(projected.label === undefined ? {} : { label: projected.label }),
        ...(projected.connectionState === undefined
          ? {}
          : { connectionState: projected.connectionState }),
      };
    }),
  };
}
