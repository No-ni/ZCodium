import type { ConversationShareAttempt } from "@/store/conversationShareSelectionStore.js";

export type { ConversationShareAttempt } from "@/store/conversationShareSelectionStore.js";

export interface ConversationShareAttemptIdFactory {
  now?: () => number;
  randomUUID?: () => string | undefined;
}

export function ensureConversationShareAttempt(
  current: ConversationShareAttempt | null,
  attemptKey: string,
  sessionId: string,
  factory: ConversationShareAttemptIdFactory = {},
): ConversationShareAttempt {
  if (current?.key === attemptKey) return current;

  const now = factory.now ?? Date.now;
  const requestSuffix = factory.randomUUID?.() ?? `${sessionId}-${now()}`;
  return { key: attemptKey, clientRequestId: `export-${requestSuffix}` };
}

/** 只有服务端明确确认记录失效才能换幂等键；超时和审核等待不能据此判断发布失败。 */
export function retainConversationShareAttemptAfterFailure(
  attempt: ConversationShareAttempt,
  code?: number,
): ConversationShareAttempt | null {
  return code === 3211 || code === 3212 ? null : attempt;
}
