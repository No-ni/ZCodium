import type {
  BotActor,
  BotConfig,
  BotInboundAttachment,
  BotInboundMessage,
  BotOutboundMessage,
  BotProviderCallbackResult,
  BotTopicHistoryBatch,
  BotTopicHistoryRequest,
  Locale,
} from "@zcode/shared";
import type { TopicResourceMessage } from "../topicResource.js";
import type { GroupInputReaction } from "./groupInputReaction.js";

export interface BotTypingTarget {
  providerUserId: string;
  providerMessageId?: string;
  providerContextToken?: string;
}

export interface BotProviderDownloadedAttachment {
  attachment: BotInboundAttachment;
  data: Uint8Array;
}

export type BotStreamingReplyCardBlock =
  | {
      type: "message";
      text: string;
    }
  | {
      type: "tools";
      summaries: string[];
      title?: string;
      expanded?: boolean;
    };

export interface BotStreamingReplyCardState {
  providerUserId: string;
  locale?: Locale;
  blocks: BotStreamingReplyCardBlock[];
  status: "running" | "sealed" | "completed" | "error";
}

export interface BotStreamingReplyCardHandle {
  providerMessageId: string;
}

export type BotTransientInteractionCardHandle = BotStreamingReplyCardHandle;

export interface BotProviderAcknowledgeResult {
  handled?: boolean;
}

/**
 * 官方任务流生命周期，供传输型 provider（如 astrbot）对齐 bridge 的 accepted→delivery→status 轮次收口。
 * `started` 表示已进入任务流（此时不应提前收口）；其余为终态/等待交互。
 */
export type BotTaskLifecyclePhase = "started" | "awaiting_input" | "completed" | "failed";

export interface BotProviderAdapter {
  // botsService 在群/话题链路按下列名字消费 adapter，缺少声明时 `providers[x]?.name?.()` 会被 tsc
  // 判为「属性不存在」。签名取自上游同文件的 MERGE_HEAD 版本，全部保持可选：provider 未实现时
  // 调用方走 `?.` 回退，不新增运行时行为，也不引入账号、遥测或云端依赖。
  /** 读取话题内某条消息的原生身份与附件，供授权后的历史附件取回。 */
  readTopicResourceMessage?(
    bot: BotConfig,
    target: { messageId: string; chatId: string; threadId: string },
    signal?: AbortSignal,
  ): Promise<TopicResourceMessage>;
  /** 专用话题群缺少 thread 根事件时，用原生消息解析话题容器身份。 */
  resolveTopic?(
    bot: BotConfig,
    actor: BotActor,
  ): Promise<{ threadId: string; rootMessageId: string; topicTitle: string; topicUrl?: string }>;
  /** 读取本轮 @ 之前的话题历史背景，返回不可变批次与检查点。 */
  readTopicHistory?(
    bot: BotConfig,
    request: BotTopicHistoryRequest,
  ): Promise<BotTopicHistoryBatch>;
  /** 群成员 open_id 到显示名的映射，供姓名解析与提及还原。 */
  getGroupMemberNames?(bot: BotConfig, chatId: string): Promise<Record<string, string>>;
  /** 群基础信息，chatMode 区分普通群与话题群。 */
  getGroupInfo?(
    bot: BotConfig,
    chatId: string,
  ): Promise<{ name: string; chatMode?: "group" | "topic" }>;
  test(bot: BotConfig): Promise<{ ok: boolean; message: string }>;
  resolveName?(bot: BotConfig): Promise<string | null>;
  syncCommands?(bot: BotConfig): Promise<void>;
  send(
    bot: BotConfig,
    message: BotOutboundMessage,
  ): Promise<void | BotTransientInteractionCardHandle>;
  /** 群输入进度的表情回写；stopped/discarded 由调用方收敛为 cancelled 后传入。 */
  updateInputReaction?(
    bot: BotConfig,
    messageId: string,
    state: GroupInputReaction,
  ): Promise<void>;
  sendTyping?(bot: BotConfig, target: BotTypingTarget): Promise<void>;
  startTyping?(bot: BotConfig, target: BotTypingTarget): Promise<void>;
  stopTyping?(bot: BotConfig, target: BotTypingTarget): Promise<void>;
  resolveActorDisplayName?(bot: BotConfig, actor: BotActor): Promise<string | null>;
  acknowledgeCallback?(
    bot: BotConfig,
    payload: unknown,
    text?: string,
    message?: BotOutboundMessage,
    signal?: AbortSignal,
  ): Promise<BotProviderAcknowledgeResult | void>;
  createStreamingReplyCard?(
    bot: BotConfig,
    state: BotStreamingReplyCardState,
    signal?: AbortSignal,
  ): Promise<BotStreamingReplyCardHandle | null>;
  updateStreamingReplyCard?(
    bot: BotConfig,
    handle: BotStreamingReplyCardHandle,
    state: BotStreamingReplyCardState,
    signal?: AbortSignal,
  ): Promise<void>;
  splitStreamingReplyCardStates?(
    state: BotStreamingReplyCardState,
  ): BotStreamingReplyCardState[];
  createTransientInteractionCard?(
    bot: BotConfig,
    message: BotOutboundMessage,
  ): Promise<BotTransientInteractionCardHandle | null>;
  updateTransientInteractionCard?(
    bot: BotConfig,
    handle: BotTransientInteractionCardHandle,
    message: BotOutboundMessage,
  ): Promise<void>;
  deleteTransientInteractionCard?(
    bot: BotConfig,
    handle: BotTransientInteractionCardHandle,
  ): Promise<void>;
  prepareCallbackPayload?(bot: BotConfig, payload: unknown): Promise<unknown>;
  handleCallbackResponse?(bot: BotConfig, payload: unknown): Promise<Pick<BotProviderCallbackResult, "responseBody" | "status"> | null>;
  downloadAttachment?(
    bot: BotConfig,
    attachment: BotInboundAttachment,
    actor?: BotActor,
    signal?: AbortSignal,
  ): Promise<BotProviderDownloadedAttachment | null>;
  /**
   * 任务流生命周期通知（可选）。仅在 provider 需要把官方轮次映射成自有传输信号时实现，
   * 不改变任何业务状态。
   */
  notifyTaskLifecycle?(bot: BotConfig, actor: BotActor, phase: BotTaskLifecyclePhase): void;
  parseCallback(payload: unknown): BotInboundMessage[];
}
