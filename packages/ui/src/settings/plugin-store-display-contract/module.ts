export const pluginStoreDisplayModule = {
  id: "plugin-store-display",
  requires: ["ui", "services", "shared", "extension-host-protocol"],
  provides: ["plugin-store-display"],
  publicEntrypoints: ["contract.ts"],
} as const;
