export function resolveWorkspaceHeaderLeadingInset({
  isSidebarVisible,
  isMacDesktop,
  isMacFullscreen,
  hasUpdateReady,
}: {
  isSidebarVisible: boolean;
  isMacDesktop?: boolean;
  isMacFullscreen?: boolean;
  hasUpdateReady: boolean;
}): string {
  if (isSidebarVisible) return "";
  if (isMacDesktop) {
    return hasUpdateReady
      ? isMacFullscreen
        ? "pl-48"
        : "pl-66"
      : isMacFullscreen
        ? "pl-38"
        : "pl-58";
  }
  return hasUpdateReady ? "pl-44" : "pl-38";
}
