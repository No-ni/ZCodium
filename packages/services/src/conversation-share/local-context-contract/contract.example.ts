import type { ConversationShareLocalContextEntry1 } from "./contract.js";
/** 调用方持有既有入口；示例只转交一次相同意图，不装配进程或读真实目录。 */
export function exampleConversationShareLocalContext(
  api: ConversationShareLocalContextEntry1,
  ...args: Parameters<
    ConversationShareLocalContextEntry1["scopeConversationShareServiceForAttachment"]
  >
): ReturnType<ConversationShareLocalContextEntry1["scopeConversationShareServiceForAttachment"]> {
  return api.scopeConversationShareServiceForAttachment(...args);
}
