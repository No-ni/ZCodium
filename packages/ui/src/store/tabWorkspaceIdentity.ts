interface WorkspaceTabIdentityLike {
  workspacePath: string;
  remoteSessionId?: string;
  workspaceIdentity?: string;
  remoteTarget?: unknown;
}

interface WorkspaceTabMatchOptions {
  remoteSessionId?: string;
  workspaceIdentity?: string;
  previousWorkspaceIdentity?: string;
}

function hasRemoteTabIdentity(tab: WorkspaceTabIdentityLike): boolean {
  return Boolean(tab.workspaceIdentity?.trim() || tab.remoteSessionId || tab.remoteTarget);
}

function isLocalWorkspaceTab(tab: WorkspaceTabIdentityLike): boolean {
  return !hasRemoteTabIdentity(tab);
}

export function isSameWorkspaceTab(
  tab: WorkspaceTabIdentityLike,
  workspacePath: string,
  options?: WorkspaceTabMatchOptions,
): boolean {
  if (tab.workspacePath !== workspacePath) {
    return false;
  }

  if (options?.workspaceIdentity) {
    return (
      tab.workspaceIdentity === options.workspaceIdentity ||
      (Boolean(options.previousWorkspaceIdentity) &&
        tab.workspaceIdentity === options.previousWorkspaceIdentity)
    );
  }

  if (options?.remoteSessionId) {
    return tab.remoteSessionId === options.remoteSessionId;
  }

  return isLocalWorkspaceTab(tab);
}
