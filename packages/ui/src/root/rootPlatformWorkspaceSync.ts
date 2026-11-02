/** 完整窗口快照只在历史恢复完成后发布；实际同步由 useWebRemoteControlWindowSync 独占。 */
export function shouldPublishCompleteWorkspaceSnapshot(
  hasCompletedFullTabRestore: boolean,
): boolean {
  return hasCompletedFullTabRestore;
}
