import type { IProjectService } from "./project/contract.js";
import type { IGenUiService } from "./gen-ui/contract.js";
import type { IPluginUiBridgeService } from "./plugin-ui-bridge/contract.js";
import type { IPluginUiSamplingService } from "./plugin-ui-bridge/samplingContract.js";
import type { IPluginUiAppToolsService } from "./plugin-ui-bridge/appToolsContract.js";
import type { IFileService } from "./file/file.js";
import type { IMediaPreviewService } from "./media-preview/mediaPreview.js";
import type { IGitService } from "./git/git.js";
import type { IGitCheckpointService } from "./git/gitCheckpoint.js";
import type { ISystemService } from "./system/system.js";
import type { ITerminalService } from "./terminal/terminal.js";
import type { ISettingService } from "./setting/setting.js";
import type { ICredentialService } from "./credential/credential.js";
import type { IBroadcastService } from "./broadcast/broadcast.js";
import type { IZCodeTaskService } from "./session/zcodeTaskService.js";
import type { IZCodeAgentService } from "./zcode-agent/zcodeAgent.js";
import type { IZCodeSessionService } from "./zcode-session/zcodeSession.js";
import type { ICuaPermissionService } from "./cua-permission-broker/cuaPermissionService.js";
import type { IBotsService } from "./bots/bots.js";
import type { IFileWatcherService } from "./fileWatcher/fileWatcher.js";
import type {
  IModelSelectionService,
  IProviderSettingsService,
} from "./model-provider/providerFacadeServices.js";
import type { IUsageStatsService } from "./usage-stats/usageStats.js";
import type { ICodingPlanSubscriptionService } from "./coding-plan-subscription/codingPlanSubscription.js";
import type { IClientConfigService } from "./client-config/clientConfig.js";
import type { IClientScenesService } from "./client-scenes/clientScenes.js";
import type { ISkillsService } from "./skills/skills.js";
import type { ISkillSyncService } from "./skill-sync/skillSync.js";
import type { IMcpSyncService } from "./mcp-sync/mcpSync.js";
import type { IPluginSyncService } from "./plugin-sync/pluginSync.js";
import type { IPluginsService } from "./plugins/plugins.js";
import type { IPluginManagementService } from "./plugins/pluginManagement.js";
import type { ISubagentsService } from "./subagents/subagents.js";
import type { ICommandsService } from "./commands/commands.js";
import type { IHooksService } from "./hooks/hooks.js";
import type { IMemoryService } from "./memory/memory.js";
import type { ISettingsSyncService } from "./settings-sync/settingsSync.js";
import type { IPromptAttachmentTransferService } from "./prompt-attachment-transfer/promptAttachmentTransfer.js";
import type { IWindowControllerService } from "./window-controller/windowController.js";
import type { IOnboardingRecordService } from "./onboarding/onboardingRecord.js";
import type { IConversationShareService } from "./conversation-share/conversationShare.js";

import type { WindowProjectDirectoryServices } from "./window-project-directory/contract.js";
import type { ISourceServerManagementService } from "./source-server-management/sourceServerManagement.js";
import type { ITaskGroupService } from "./task-groups/contract.js";
import type { ISourceServerWorkspaceService } from "./source-server-workspace/sourceServerWorkspace.js";
import type { IDeviceSyncStateService, IUserConfigSyncService } from "./data-sync/contract.js";
import type { IProviderProvisioningStatusService } from "./provider-provisioning-status/contract.js";
/** UI 层消费的统一服务接口 */
export interface IServiceAccessor {
  /** 已部署 Source 的真实项目 owner；旧宿主没有此能力时拒绝远端项目请求。 */
  readonly projectService?: IProjectService;
  readonly fileService: IFileService;
  readonly mediaPreviewService?: IMediaPreviewService;
  readonly gitService: IGitService;
  readonly gitCheckpointService: IGitCheckpointService;
  readonly systemService: ISystemService;
  readonly terminalService: ITerminalService;
  readonly settingService: ISettingService;
  /** Onboarding 完成记录（本地持久化）；旧测试 double / 不支持的 host 可不提供。 */
  readonly onboardingRecordService?: IOnboardingRecordService;
  readonly credentialService: ICredentialService;
  readonly broadcastService: IBroadcastService;
  readonly zcodeTaskService: IZCodeTaskService;
  /** 窗口 Host 聚合面；旧 server wire 或测试 double 可暂不提供。 */
  readonly windowControllerService?: IWindowControllerService;
  readonly sourceServerManagementService?: ISourceServerManagementService;
  /** Source Server 工作区解析与迁移报告；旧 host 或测试 double 可不提供。 */
  readonly sourceServerWorkspaceService?: ISourceServerWorkspaceService;
  readonly windowProjectDirectory?: WindowProjectDirectoryServices;
  /** 控制端本地组织结构，所有远端任务仍按 Host 身份验证与登记。 */
  readonly taskGroupService?: ITaskGroupService;
  readonly zcodeAgentService: IZCodeAgentService;
  readonly zcodeSessionService: IZCodeSessionService;
  // CUA 是 opt-in 内测特性：local macOS host 提供，远端 等 host 没有。可选避免连锁必填。
  readonly cuaPermissionService?: ICuaPermissionService;
  readonly conversationShareService: IConversationShareService;
  readonly botsService: IBotsService;
  readonly fileWatcherService: IFileWatcherService;
  /** 当前 Environment 的 Provider 配置与设置视图。 */
  readonly providerSettingsService: IProviderSettingsService;
  /** 当前 Environment Registry 发布的唯一模型选择 View。 */
  readonly modelSelectionService: IModelSelectionService;
  readonly usageStatsService: IUsageStatsService;
  readonly codingPlanSubscriptionService: ICodingPlanSubscriptionService;
  readonly clientConfigService: IClientConfigService;
  readonly clientScenesService: IClientScenesService;
  /** 闲时任务管理（独立服务面）。 */
  readonly skillsService: ISkillsService;
  readonly skillSyncService: ISkillSyncService;
  readonly mcpSyncService: IMcpSyncService;
  /** 子智能体 / 命令 / 钩子共用的数据同步通道（docs/remote/data-sync.md）。 */
  readonly userConfigSyncService?: IUserConfigSyncService;
  /** 仅桌面本机 Host 注册：数据同步页读取的设备同步状态。 */
  readonly deviceSyncStateService?: IDeviceSyncStateService;
  /** Provisioning lane 状态只由桌面本机控制端提供，远端与手机不隐含开放。 */
  readonly providerProvisioningStatusService?: IProviderProvisioningStatusService;
  /** 插件 UI 桥；web 或旧 host 可不提供，UI 据此回退普通 MCP 卡片。 */
  readonly genUiService?: IGenUiService;
  readonly pluginUiBridgeService?: IPluginUiBridgeService;
  /** 页面 sampling；只有桌面本地任务开放。 */
  readonly pluginUiSamplingService?: IPluginUiSamplingService;
  /** App-Provided Tools；只有桌面本地 agent 时存在。 */
  readonly pluginUiAppToolsService?: IPluginUiAppToolsService;
  readonly pluginSyncService: IPluginSyncService;
  readonly pluginsService: IPluginsService;
  /** 设置页插件管理（UI 不再直触 zcodeAgentService 的 plugins/* 面） */
  readonly pluginManagementService: IPluginManagementService;
  readonly subagentsService: ISubagentsService;
  readonly commandsService: ICommandsService;
  readonly hooksService: IHooksService;
  readonly memoryService: IMemoryService;
  readonly settingsSyncService: ISettingsSyncService;
  readonly promptAttachmentTransferService: IPromptAttachmentTransferService;
}
