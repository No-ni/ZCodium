export const pluginStoreDisplayModule = {
  id: "plugin-store-display",
  requires: ["ui"],
  provides: ["plugin-store-display"],
  publicEntrypoints: ["contract.ts"],
} as const;
