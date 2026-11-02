export const desktopSourceSettingsBridgeModule = {
  id: "desktop-source-settings-bridge",
  requires: ["client", "shared", "ui"],
  provides: ["desktop-source-settings-bridge"],
  publicEntrypoints: ["contract.ts"],
} as const;
