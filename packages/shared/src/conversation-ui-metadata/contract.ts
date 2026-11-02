/** 首次创建来源和会话 DOM 定位标识是纯契约；不保存会话事实，不涉及遥测或网络。公开调用类型沿当前源码，不另造状态或执行入口。 */
export type ConversationUiMetadataEntry1 = typeof import("../sessionCreateSource.js");
export type { SessionCreateSource } from "../sessionCreateSource.js";
export type ConversationUiMetadataEntry2 = typeof import("../test-ids-conversation.js");
