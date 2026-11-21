export const conversationMaterializationModule = {
  id: "cli-conversation-materialization",
  requires: ["agent-contracts", "shared", "zcode-cli"],
  provides: ["cli-conversation-materialization"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
