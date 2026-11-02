export const sourceServerUiModule = {
  id: "source-server-ui",
  requires: ["services", "shared", "ui"],
  provides: ["source-server-ui"],
  publicEntrypoints: ["contract.ts"],
} as const;
