import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type {
  ZCodeConfigOption,
  ZCodeProvider,
  BotConfig,
  BotContextState,
  BotInboundMessage,
  BotOutboundMessage,
  BotProvider,
  BotProviderCallbackResult,
  BotServiceStatus,
  BotWorkspaceRef,
  BotsConfigFile,
  ZCodeAutomationBotDeliveryTarget,
} from "@zcode/shared";
import type { ZCodeAgentAppRuntimePreferences } from "../zcode-agent/zcodeAgent.js";

export interface BotCreateBindCodeParams {
  botId?: string;
  allowedWorkspaces?: string[];
  ttlMs?: number;
}

export interface BotSaveBotParams {
  bot: BotConfig;
  credentialValue?: string;
  webhookSecretValue?: string;
}

export interface BotTestResult {
  ok: boolean;
  message: string;
  name?: string;
  provider?: BotProvider;
}

export interface BotBindCodeResult {
  code: string;
  expiresAt: number;
}

export interface BotListWorkspaceRefsParams {
  currentWorkspace?: BotWorkspaceRef;
}

export interface BotUserConfigOptionsParams {
  workspacePath: string;
  workspaceIdentity?: string;
  provider: ZCodeProvider;
}

export interface BotAutomationRunWatchParams {
  /** 与该次 sendPrompt.traceId 一致，避免排队期间污染其他轮次。 */
  runId?: string;
  target: ZCodeAutomationBotDeliveryTarget;
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface BotWeixinRegistrationBeginResult {
  qrCode: string;
  qrUrl: string;
  interval: number;
  expiresAt: number;
}

export interface BotWeixinRegistrationPollParams {
  qrCode: string;
}

export type BotWeixinRegistrationPollResult =
  | {
      status: "pending" | "scanned";
      interval: number;
    }
  | {
      status: "success";
      botToken: string;
      botId?: string;
    }
  | {
      status: "expired" | "error";
      message?: string;
    };

export interface BotFeishuRegistrationBeginParams {
  domain?: "feishu" | "lark";
}

export interface BotFeishuRegistrationBeginResult {
  deviceCode: string;
  qrUrl: string;
  userCode: string;
  interval: number;
  expiresAt: number;
  domain: "feishu" | "lark";
  pollDomain?: "feishu" | "lark";
}

export interface BotFeishuRegistrationPollParams {
  deviceCode: string;
  domain?: "feishu" | "lark";
  pollDomain?: "feishu" | "lark";
}

export type BotFeishuRegistrationPollResult =
  | {
      status: "pending";
      interval: number;
      domain: "feishu" | "lark";
      pollDomain?: "feishu" | "lark";
    }
  | {
      status: "success";
      appId: string;
      appSecret: string;
      domain: "feishu" | "lark";
      appName?: string;
      openId?: string;
    }
  | {
      status: "access_denied" | "expired" | "error";
      message?: string;
      domain: "feishu" | "lark";
    };

export interface IBotsService {
  // 以下成员是 botsService 已实现、但本文件在合并中漏掉的公开接口，签名逐字取自上游 MERGE_HEAD。
  /** 把宿主侧的频道回复请求落到已绑定的群会话，并回写投递结果。 */
  replyToChannel?(
    params: import("@zcode/shared").ChannelReplyHostRequest,
  ): Promise<import("@zcode/shared").ChannelReplyResult>;
  /** 在读取话题附件前校验该输入仍属于当前授权范围。 */
  validateTopicResource?(
    params: import("#src/bots/topicResource.js").TopicResourceRequest,
  ): Promise<void>;
  /** 授权通过后取回话题内的历史附件。 */
  readTopicResource?(
    params: import("#src/bots/topicResource.js").TopicResourceRequest,
  ): Promise<import("@zcode/shared").ZCodePromptAttachment>;
  /**
   * 将 App 全局交互偏好同步给 Bot 已持有的远端 runtime；不得为此建立新的远端连接。
   */
  syncAppRuntimePreferences(preferences: ZCodeAgentAppRuntimePreferences): Promise<void>;
  getStatus(): Promise<BotServiceStatus>;
  getConfig(): Promise<BotsConfigFile>;
  listWorkspaceRefs(params?: BotListWorkspaceRefsParams): Promise<BotWorkspaceRef[]>;
  getUserConfigOptions(params: BotUserConfigOptionsParams): Promise<ZCodeConfigOption[]>;
  beginFeishuRegistration(
    params?: BotFeishuRegistrationBeginParams,
  ): Promise<BotFeishuRegistrationBeginResult>;
  pollFeishuRegistration(
    params: BotFeishuRegistrationPollParams,
  ): Promise<BotFeishuRegistrationPollResult>;
  beginWeixinRegistration(): Promise<BotWeixinRegistrationBeginResult>;
  pollWeixinRegistration(
    params: BotWeixinRegistrationPollParams,
  ): Promise<BotWeixinRegistrationPollResult>;
  saveConfig(config: BotsConfigFile): Promise<BotsConfigFile>;
  listBots(): Promise<BotConfig[]>;
  saveBot(params: BotSaveBotParams): Promise<BotConfig>;
  removeBotSecret(botId: string): Promise<BotConfig>;
  deleteBot(botId: string): Promise<void>;
  testBot(botId: string): Promise<BotTestResult>;
  createBindCode(params: BotCreateBindCodeParams): Promise<BotBindCodeResult>;
  /** 群成员 open_id 到显示名的映射，供提及还原；只有支持名单的 provider 群可用。 */
  getGroupMemberNames?(params: { botId: string; chatId: string }): Promise<Record<string, string>>;
  getBotStates(): Promise<BotContextState[]>;
  /** 重新准备因网络或材料缺失而未成功的话题输入。 */
  retryTopicPreparation?(params: {
    botId: string;
    chatId: string;
    threadId: string;
    messageId: string;
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<void>;
  /** 话题上下文的可查看细节：消息数、是否有缺口、历史开关与摘要检查点。 */
  getTopicDetails?(params: {
    botId: string;
    chatId: string;
    threadId?: string;
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<{
    messageCount: number;
    hasGap: boolean;
    historyEnabled: boolean;
    summaries: Array<{ checkpoint: string; text: string }>;
  }>;

  /** 由群管理员在设置界面开合某个群的接入，等价于管理员发送 /enable 或 /disable。 */
  setGroupEnabled?(params: { botId: string; chatId: string; enabled: boolean }): Promise<void>;
  /** 投递结果长期未知时，由用户确认是否收到，据此收敛为 sent 或 failed。 */
  reconcileGroupResult?(params: {
    botId: string;
    chatId: string;
    deliveryId: string;
    threadId?: string;
    received: boolean;
  }): Promise<import("@zcode/shared").BotGroupDelivery>;
  /** 对已保存的群结果重新执行一次原生投递，不重新生成内容。 */
  resendGroupResult?(params: {
    botId: string;
    chatId: string;
    deliveryId: string;
    threadId?: string;
  }): Promise<import("@zcode/shared").BotGroupDelivery>;
  /** 重试仍留在失败表里的私聊回复。 */
  retryPrivateDelivery?(params: { botId: string; deliveryId: string }): Promise<void>;
  resetBotState(contextKey: string): Promise<void>;
  /** 在 automation prompt 派发前订阅终态，并把结果回推到创建它的 Bot 会话。 */
  watchAutomationRun(params: BotAutomationRunWatchParams): Promise<void>;
  handleInboundMessage(message: BotInboundMessage): Promise<BotOutboundMessage[]>;
  handleProviderCallback(provider: BotProvider, payload: unknown): Promise<BotOutboundMessage[]>;
  handleProviderCallbackResponse(
    provider: BotProvider,
    payload: unknown,
  ): Promise<BotProviderCallbackResult>;
}

export const IBotsService = createServiceDescriptor<IBotsService>(ServiceChannels.Bots);

/** Host 负责把旧线路身份解析到当前 Source；不允许 services 猜测连接目录。 */
export interface BotRemoteWorkspaceResolution {
  workspacePath: string;
  workspaceIdentity: string;
  target: import("@zcode/shared").RemoteTarget;
  /** 只有当前窗口存在在线 logical session 才有值，用于 attachment 换代隔离。 */
  runtimeKey?: string;
}
export type BotRemoteWorkspaceResolver = (
  workspace: { workspacePath: string; workspaceIdentity: string },
  purpose: "lookup" | "reconnect",
) => Promise<BotRemoteWorkspaceResolution | null>;
