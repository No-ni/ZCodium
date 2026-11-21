export const agentPluginDiscoveryModule = {
  id: "agent-plugin-discovery",
  requires: [
    "agent-contracts",
    "agent-protocol-values",
    "plugin-install-interaction",
    "shared",
    "zcode-cli",
  ],
  provides: ["agent-plugin-discovery"],
  publicEntrypoints: ["contract.ts", "subscription.ts"],
} as const;
