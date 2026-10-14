export interface CodeViewerWorkspaceScope {
  workspacePath?: string;
  fileReferenceRootPath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
}

export function withCodeViewerWorkspaceScope<T extends object>(
  source: T,
  scope: CodeViewerWorkspaceScope,
): T & CodeViewerWorkspaceScope {
  return { ...source, ...scope };
}
