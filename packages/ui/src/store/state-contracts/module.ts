export const storeStateContractsModule = {
  id: "store-state-contracts",
  requires: ["shared", "services"],
  provides: ["store-state-contracts"],
  publicEntrypoints: ["contract.ts"],
} as const;
