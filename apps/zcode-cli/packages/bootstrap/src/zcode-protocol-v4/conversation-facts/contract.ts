/**
 * cli-conversation-facts 对外契约：调用方要想正确调用就必须知道的一切都写在这里；其余对外不可见。
 * 每个方法注释写清：前置/后置条件、幂等性、发出哪些事件、是否等待持久化。
 */
export {
  normalizeModelStreaming,
  runtimeTurnIdOf,
  normalizeAttachments,
  turnHeaderOrigin,
  userInputOrigin,
} from "./values.js";
export type {
  CanonicalConversationVisibility,
  CanonicalConversationOrigin,
  CanonicalConversationPlacement,
  ConversationNormalizationDiagnostic,
  CanonicalUserIntentFact,
  CanonicalTurnAttachment,
  CanonicalModelStream,
  CanonicalAssistantSegmentFact,
  CanonicalPassthroughFact,
  CanonicalConversationFact,
  NormalizeConversationEventContext,
  CanonicalOpenSegmentIdentity,
} from "./values.js";
