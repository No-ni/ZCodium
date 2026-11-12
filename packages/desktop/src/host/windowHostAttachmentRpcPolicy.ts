import { type IChannelServer } from "@zcode/rpc";
import {
  ServiceCollection,
  IMcpSyncService,
  ISettingsSyncService,
  type ServiceExposurePolicy,
  type ZCodeAgentV4ClientMode,
} from "@zcode/services";
import { ServiceChannels } from "@zcode/shared";

const WEB_REMOTE_REPLAYABLE_EXPOSURE_POLICY: ServiceExposurePolicy = {
  allowedChannels: new Set<string>([
    ServiceChannels.File,
    ServiceChannels.MediaPreview,
    ServiceChannels.System,
    ServiceChannels.Terminal,
    ServiceChannels.Git,
    ServiceChannels.GitCheckpoint,
    ServiceChannels.Setting,
    ServiceChannels.SettingsSync,
    ServiceChannels.OnboardingRecord,
    ServiceChannels.Credential,
    ServiceChannels.CuaPermission,
    ServiceChannels.Broadcast,
    ServiceChannels.ZCodeTask,
    ServiceChannels.WindowController,
    ServiceChannels.ZCodeAgent,
    ServiceChannels.ZCodeSession,
    ServiceChannels.Project,
    ServiceChannels.TaskGroups,
    ServiceChannels.RemoteProjects,
    ServiceChannels.WindowProject,
    ServiceChannels.WindowRemoteProjects,
    ServiceChannels.WindowProjectChanges,
    ServiceChannels.ConversationShare,
    ServiceChannels.FileWatcher,
    ServiceChannels.ProviderSettings,
    ServiceChannels.ModelSelection,
    ServiceChannels.SourceServerWorkspace,
    ServiceChannels.UsageStats,
    ServiceChannels.CodingPlanSubscription,
    ServiceChannels.ClientScenes,
    ServiceChannels.Skills,
    ServiceChannels.McpSync,
    ServiceChannels.Plugins,
    ServiceChannels.PluginManagement,
    ServiceChannels.Subagents,
    ServiceChannels.Commands,
    ServiceChannels.Hooks,
    ServiceChannels.Memory,
    ServiceChannels.OutputStyle,
    ServiceChannels.Bots,
    ServiceChannels.PromptAttachmentTransfer,
  ]),
};

export function resolveWindowHostServiceExposurePolicy(
  clientMode: ZCodeAgentV4ClientMode,
): ServiceExposurePolicy | undefined {
  // 新服务曾随注册自动开放给手机；显式白名单让未审阅的设备控制和配置同步默认拒绝。
  return clientMode === "web-remote-replayable" ? WEB_REMOTE_REPLAYABLE_EXPOSURE_POLICY : undefined;
}

const MOBILE_MCP_SYNC_ALLOWED_METHODS = new Set<string>([
  "loadMcpFromUserDirectory",
  "saveMcpToUserDirectory",
  "listWorkspaceMcpServerStatuses",
  "setWorkspaceMcpTrust",
] satisfies ReadonlyArray<keyof IMcpSyncService>);

function scopeMcpSyncServiceForMobile(service: IMcpSyncService): IMcpSyncService {
  const rejectMobileSync = async (): Promise<never> => {
    throw Object.assign(new Error("Remote sync is only available from Desktop"), {
      kind: "feature_disabled" as const,
    });
  };
  return new Proxy({} as IMcpSyncService, {
    get: (_target, key) => {
      if (typeof key !== "string" || key === "then" || /^on[A-Z]/.test(key)) return undefined;
      if (!MOBILE_MCP_SYNC_ALLOWED_METHODS.has(key)) return rejectMobileSync;
      const method = service[key as keyof IMcpSyncService] as (...args: unknown[]) => unknown;
      return (...args: unknown[]) => method.apply(service, args);
    },
  });
}

const MOBILE_FIRST_RUN_ALLOWED_METHODS = new Set<string>([
  "getFirstRunPromptState",
  "markFirstRunPromptHandled",
] satisfies ReadonlyArray<keyof ISettingsSyncService>);

function scopeSettingsSyncServiceForMobile(service: ISettingsSyncService): ISettingsSyncService {
  const rejectMobileMigration = async (): Promise<never> => {
    throw Object.assign(new Error("Settings migration is only available from Desktop"), {
      kind: "feature_disabled" as const,
    });
  };
  return new Proxy({} as ISettingsSyncService, {
    get: (_target, key) => {
      if (typeof key !== "string" || key === "then" || /^on[A-Z]/.test(key)) return undefined;
      if (!MOBILE_FIRST_RUN_ALLOWED_METHODS.has(key)) return rejectMobileMigration;
      const method = service[key as keyof ISettingsSyncService] as (...args: unknown[]) => unknown;
      return (...args: unknown[]) => method.apply(service, args);
    },
  });
}

export function exposeWindowHostAttachmentServices(params: {
  server: IChannelServer;
  services: ServiceCollection;
  clientMode: ZCodeAgentV4ClientMode;
  overrides?: ReadonlyMap<string, unknown>;
}): void {
  let overrides = params.overrides;
  if (params.clientMode === "web-remote-replayable") {
    const mcpSync =
      (overrides?.get(IMcpSyncService.channelName) as IMcpSyncService | undefined) ??
      params.services.getOptional(IMcpSyncService);
    if (mcpSync)
      overrides = new Map(overrides).set(
        IMcpSyncService.channelName,
        scopeMcpSyncServiceForMobile(mcpSync),
      );
    // 共享引导读取被整体拒绝时会反复弹窗；仅转发首启生命周期，导入/发现能力仍默认拒绝。
    const settingsSync =
      (overrides?.get(ISettingsSyncService.channelName) as ISettingsSyncService | undefined) ??
      params.services.getOptional(ISettingsSyncService);
    if (settingsSync)
      overrides = new Map(overrides).set(
        ISettingsSyncService.channelName,
        scopeSettingsSyncServiceForMobile(settingsSync),
      );
  }
  params.services.exposeOnChannelServer(
    params.server,
    overrides,
    resolveWindowHostServiceExposurePolicy(params.clientMode),
  );
}
