/**
 * Public V4 conversation client surface for non-React consumers.
 *
 * Example:
 * ```ts
 * const transport = createAgentConversationTransport(agentService, {
 *   workspacePath,
 *   workspaceIdentity,
 *   remoteSessionId,
 * });
 * const layer = new SessionDataLayer({ transport });
 * const lease = layer.acquire(sessionId);
 * const unsubscribe = lease.store.subscribe(() => render(lease.store.getState()));
 * const ack = await transport.sendCommand(createCommandEnvelope({ type, sessionId, payload }));
 * unsubscribe();
 * lease.release();
 * layer.dispose();
 * ```
 * SessionDataLayer and its projection store own subscription, replay, and snapshot/delta state.
 */
export { createAgentConversationTransport } from "./v4/agentConversationTransport.js";
export { SessionDataLayer } from "./v4/sessionDataLayer.js";
export type { SessionLease } from "./v4/sessionDataLayer.js";
export type { ConversationTransport } from "./v4/transport.js";
export type {
  ConversationStoreState,
  ConversationStoreStatus,
  OptimisticCommand,
} from "./v4/conversationProjectionStore.js";
export { createCommandEnvelope } from "./v4/commandFactory.js";
export { pendingCommandRegistry } from "./v4/pendingCommandRegistry.js";
export type {
  PendingCommandEntry,
  PendingCommandRecoveryReason,
  PendingCommandReplay,
} from "./v4/pendingCommandRegistry.js";
export type {
  CommandAck,
  CommandEnvelope,
  CommandPayloadMap,
  CommandType,
  ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";
