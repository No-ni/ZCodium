/** 分享沿当前可信 attachment 读取冻结的会话/工作流/文件；只生成本地导出上下文，不上传，不制造第二个连接或快照 owner。公开调用类型沿当前源码，不另造状态或执行入口。 */
export type ConversationShareLocalContextEntry1 =
  typeof import("../conversationShareConnectionScope.js");
export type ConversationShareLocalContextEntry2 =
  typeof import("../conversationShareWorkflowSnapshot.js");
export type { ShareWorkflowReader } from "../conversationShareWorkflowSnapshot.js";
export type { ShareContentDraft } from "../conversationShareWorkflowSnapshot.js";
export type ConversationShareLocalContextEntry3 =
  typeof import("../conversationShareWorkflowSnapshotContent.js");
