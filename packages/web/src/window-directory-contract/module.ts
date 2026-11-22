export const webWindowDirectoryModule = {
  id: "web-window-directory",
  requires: ["shared"],
  provides: ["web-window-directory"],
  publicEntrypoints: ["contract.ts"],
} as const;
