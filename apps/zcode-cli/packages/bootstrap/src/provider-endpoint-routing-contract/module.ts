export const providerEndpointRoutingModule = {
  id: "provider-endpoint-routing",
  requires: ["agent-contracts", "zcode-cli"],
  provides: ["provider-endpoint-routing"],
  publicEntrypoints: ["contract.ts"],
} as const;
