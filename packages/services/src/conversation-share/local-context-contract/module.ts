export const conversationShareLocalContextModule = {
  id: "conversation-share-local-context",
  requires: ["services", "shared"],
  provides: ["conversation-share-local-context"],
  publicEntrypoints: ["contract.ts"],
} as const;
