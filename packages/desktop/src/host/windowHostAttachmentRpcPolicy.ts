import { type IChannelServer, type IDisposable, ProxyChannel } from "@zcode/rpc";
import type { ITerminalService } from "@zcode/services";
import {
  ServiceCollection,
  IMcpSyncService,
  IGenUiService,
  type ServiceExposurePolicy,
  type ZCodeAgentV4ClientMode,
} from "@zcode/services";
import type { WindowHostAttachmentScope } from "@zcode/shared";
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

function resolveAttachmentOverrides(
  services: ServiceCollection,
  clientMode: ZCodeAgentV4ClientMode,
  overrides: ReadonlyMap<string, unknown> | undefined,
): ReadonlyMap<string, unknown> | undefined {
  if (clientMode !== "web-remote-replayable") return overrides;
  const mcpSync =
    (overrides?.get(IMcpSyncService.channelName) as IMcpSyncService | undefined) ??
    services.getOptional(IMcpSyncService);
  if (!mcpSync) return overrides;
  const scoped = new Map(overrides);
  if (mcpSync) scoped.set(IMcpSyncService.channelName, scopeMcpSyncServiceForMobile(mcpSync));
  return scoped;
}

export function exposeWindowHostAttachmentServices(params: {
  server: IChannelServer;
  services: ServiceCollection;
  clientMode: ZCodeAgentV4ClientMode;
  overrides?: ReadonlyMap<string, unknown>;
  attachmentScope?: WindowHostAttachmentScope;
  windowServices?: ServiceCollection;
}): void {
  params.services.exposeOnChannelServer(
    params.server,
    resolveAttachmentOverrides(params.services, params.clientMode, params.overrides),
    {
      ...resolveWindowHostServiceExposurePolicy(params.clientMode),
      // 只有本机桌面 MessagePort 具备恢复权限；远端、手机和未知 scope 均默认拒绝。
      ...(params.clientMode === "desktop-continuous" && params.attachmentScope?.kind === "local"
        ? { credentialStoreRecovery: "local-desktop" as const }
        : {}),
    },
  );
  if (params.clientMode === "web-remote-replayable") {
    const controllerServices =
      params.attachmentScope?.kind === "remote" ? params.windowServices : params.services;
    const genUi = controllerServices?.getOptional(IGenUiService);
    if (genUi) {
      // 发送前 listState 曾因整频道被拒而固定等待超时。只发布控制端的只读上下文接口，
      // 不把 sandbox、文件读取或状态写入连同完整 Gen UI 服务开放给手机。
      params.server.registerChannel(
        IGenUiService.channelName,
        ProxyChannel.fromService({ listState: genUi.listState.bind(genUi) }),
      );
    }
  }
}

/** 手机终端属于页面 owner，不属于可随导航换代的 RPC attachment。 */
export function createWindowHostTerminalOwners(onCleanupError: (error: unknown) => void) {
  let current:
    | { id: string; scopes: Map<string, ReturnType<typeof createTerminalScope>> }
    | undefined;
  return {
    setOwner(id: string | null): void {
      if (current?.id === id) return;
      const previous = current;
      current = id === null ? undefined : { id, scopes: new Map() };
      // 先撤销旧 owner，再异步回收；旧 attachment 和晚到 create 均不能复活它。
      for (const scope of previous?.scopes.values() ?? []) scope.dispose();
    },
    bind(ownerId: string, scopeKey: string, base: ITerminalService): ITerminalService {
      if (current?.id !== ownerId) throw new Error("Terminal owner has ended");
      let scope = current.scopes.get(scopeKey);
      if (!scope) {
        scope = createTerminalScope(base, onCleanupError);
        current.scopes.set(scopeKey, scope);
      }
      return scope.service;
    },
  };
}

/** 旧客户端没有页面 owner 时按 attachment 回收，避免继续产生无主 PTY。 */
export function createTerminalScope(
  base: ITerminalService,
  onCleanupError: (error: unknown) => void,
) {
  let active = true;
  const terminals = new Map<string, IDisposable>();
  function assertActive(id?: string): void {
    if (!active || (id !== undefined && !terminals.has(id))) {
      throw new Error("Terminal owner has ended or does not own this terminal");
    }
  }
  const release = async (id: string) => {
    await base.dispose({ id });
    terminals.get(id)?.dispose();
    terminals.delete(id);
  };
  const service: ITerminalService = {
    async create(params) {
      assertActive();
      const result = await base.create(params);
      // create 跨 RPC/加载 await；owner 已结束时必须回收返回的真实 PTY，不能只丢响应。
      if (!active) {
        await base.dispose({ id: result.id });
        throw new Error("Terminal owner has ended");
      }
      const subscription = base.onDynamicExit(result.id)(() => {
        terminals.get(result.id)?.dispose();
        terminals.delete(result.id);
      });
      terminals.set(result.id, subscription);
      return result;
    },
    async write(params) {
      assertActive(params.id);
      await base.write(params);
    },
    async resize(params) {
      assertActive(params.id);
      await base.resize(params);
    },
    async dispose({ id }) {
      if (!active || !terminals.has(id)) return;
      await release(id);
    },
    async listTerminalIdsUnderPath(params) {
      assertActive();
      // attachment 只能看到自己创建的终端，不能借查询枚举 Host 上其他 owner 的终端。
      return (await base.listTerminalIdsUnderPath(params)).filter((id) => terminals.has(id));
    },
    onDynamicData(id) {
      assertActive(id);
      return base.onDynamicData(id);
    },
    onDynamicExit(id) {
      assertActive(id);
      return base.onDynamicExit(id);
    },
  };
  return {
    service,
    dispose(): void {
      if (!active) return;
      active = false;
      for (const [id, subscription] of terminals) {
        subscription.dispose();
        void release(id).catch(onCleanupError);
      }
    },
  };
}
