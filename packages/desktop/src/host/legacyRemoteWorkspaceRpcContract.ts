import type { IServiceAccessor } from "@zcode/services";

/** 窗口 Host 组合服务前验证既有远端必需通道，不重新引入自动部署 wire。 */
const LEGACY_REMOTE_WORKSPACE_RPC_CHANNELS = [
  "fileService",
  "gitService",
  "gitCheckpointService",
  "systemService",
  "terminalService",
  "zcodeTaskService",
  "zcodeAgentService",
  "zcodeSessionService",
  "fileWatcherService",
  "skillsService",
  "skillSyncService",
  "mcpSyncService",
  "pluginSyncService",
  "pluginsService",
  "pluginManagementService",
  "commandsService",
  "hooksService",
  "modelSelectionService",
  "providerSettingsService",
] as const satisfies readonly (keyof IServiceAccessor)[];

type LegacyRemoteWorkspaceRpcContract = Pick<
  IServiceAccessor,
  (typeof LEGACY_REMOTE_WORKSPACE_RPC_CHANNELS)[number]
>;

export function assertLegacyRemoteWorkspaceRpcContract(
  value: Partial<IServiceAccessor>,
): asserts value is Partial<IServiceAccessor> & LegacyRemoteWorkspaceRpcContract {
  const missing = LEGACY_REMOTE_WORKSPACE_RPC_CHANNELS.filter((channel) => {
    const service = value[channel];
    return (typeof service !== "object" || service === null) && typeof service !== "function";
  });
  if (missing.length > 0)
    throw new Error(`Legacy remote workspace RPC channel 不完整: ${missing.join(", ")}`);
}
