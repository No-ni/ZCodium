import type { GenUiModelContext } from "@zcode/shared/gen-ui";
import type { ModelSelection } from "../model/model.js";

export type TurnSteerCommandKind = "sendText" | "sendGoalCommand" | "compact";

/** message.data metadata.highspeed 的持久化契约；不包含运行时凭据。 */
export interface HighspeedMessageMetadata {
  schemaVersion: 1;
  ownerKey?: string;
  cardId: string;
  taskId: string;
  provider: string;
  model: string;
  issuedAt: number;
  expiresAt: number;
  regularTps?: number;
  outputTokens?: number;
  durationMs?: number;
  savedDurationMs?: number;
  modelDurationMs?: number;
  toolDurationMs?: number;
  otherDurationMs?: number;
  fallbackAt?: number;
  fallbackReason?:
    | "highspeed_card_expired"
    | "highspeed_request_failed"
    | "highspeed_selection_unavailable";
}

/**
 * 协议无关的输入 intent metadata；bootstrap v4 在事件边界组装为 ConversationInputIntent。
 * 与 @zcode/shared 的 conversationInputSourceSchema 一一对应（docs/design/v2/conversation-input-source.md）。
 */
export type TurnInputSourceMetadata =
  | { kind: "pluginUi"; pluginId: string; toolCallId: string }
  | { kind: "genUi"; path: string; title?: string }
  // title 只读旧数据（规格 0.13）：标题是会变的派生展示字段，新数据只带身份。
  | { kind: "session"; sessionId: string; title?: string }
  // 扩展经 Window Host 代发；只由 Host 注入，模型与工具不能设置。
  | { kind: "extension"; pluginId: string };

// 仅当前 CLI 实例内传递本次输入的能力。Symbol 键不进入 JSON 历史，冷恢复不能继承旧端的授权。
export const PLUGIN_DISCOVERY_INPUT = Symbol("pluginDiscoveryInput");

export interface TurnInputIntentMetadata {
  [PLUGIN_DISCOVERY_INPUT]?: true;
  planEnabled?: boolean;
  conversationQuotes?: Array<{
    text: string;
    path?: string;
    senderName?: string;
    senderId?: string;
    messageId?: string;
    sentAt?: string;
    /** 用户对该选区的批注，随引用一起作为模型材料。 */
    comment?: string;
    /** 选区来自子 agent 输出时的 agent 类型。 */
    agent?: string;
  }>;
  inputOrigin?: "desktop" | "mobile";
  botGroupSource?: {
    botIdentity?: { name: string; openId?: string };
    mentionedBot?: boolean;
    appId?: string;
    contentParts?: import("@zcode/shared").ChannelContentPart[];
    messages?: Array<{
      mentionedBot?: boolean;
      messageId: string;
      senderId: string;
      senderName: string;
      text: string;
      attachmentIndexes: number[];
      contentParts?: import("@zcode/shared").ChannelContentPart[];
    }>;
    /** 入队时由 Host 注入，历史资源请求不能借用后续重新授权的版本。 */
    authorizationId?: string;
    botId: string;
    provider: "feishu" | "lark";
    chatId: string;
    threadId?: string;
    rootMessageId?: string;
    topicContext?: {
      checkpoint: string;
      hasGap: boolean;
      messages: Array<{
        id: string;
        chatId: string;
        threadId: string;
        senderId: string;
        senderType: "user" | "app";
        text: string;
        createdAt: number;
        kind: string;
        deleted?: boolean;
      }>;
    };
    senderId: string;
    senderName: string;
    messageId: string;
  };
  sourceCommandId: string;
  queueItemId: string;
  clientId: string;
  kind: TurnSteerCommandKind;
  /** transcript hydration 贯穿完整 ConversationInputIntent 的 canonical command text。 */
  text?: string;
  /** Admission 时固定；Queue/Guide 后续不得重新读取 Composer 或 Session 最新选择。 */
  modelSelection?: ModelSelection;
  /** 与本次用户 Submission 一起固定的协作模式。 */
  mode?: "build" | "edit" | "plan" | "yolo" | "guarded";
  admissionSeq: number;
  admittedAt: number;
  requestedDelivery: "auto" | "startNow" | "queue" | "guide";
  admittedDelivery: "startNow" | "queue" | "guide";
  queuePosition?: number;
  fallbackReasonCode?: string;
  attachmentRefs?: Array<{
    ref: string;
    fileName: string;
    mime: string;
    bytes: number;
    previewRef?: string;
    sourceKind?: "clipboard-text" | "topic-history";
    messageCount?: number;
  }>;
  highspeed?: HighspeedMessageMetadata;
  /** 发送时冻结的页面状态；不得混入用户正文或出队时重新读取。 */
  genUiContext?: GenUiModelContext;
  sharedContextRefs?: Array<{
    kind: "shared_context_import";
    context_id: string;
  }>;
  /** edit/retry 重建的新 command 对原始 canonical input cause 的稳定追溯。 */
  provenance?: {
    sourceCommandId: string;
    queueItemId?: string;
    clientId?: string;
  };
  /** 插件、交互视图或会话代发的结构化来源；用户亲自输入时缺省。 */
  source?: TurnInputSourceMetadata;
}

/** queue 内保留尚未 resolve 的附件描述；消费时与普通 turn 使用同一 resolver。 */
export interface PendingTurnAttachment {
  type: "file" | "image" | "video" | "pdf" | "url";
  path?: string;
  content?: string;
  sourceKind?: "clipboard-text" | "topic-history";
  messageCount?: number;
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
}
