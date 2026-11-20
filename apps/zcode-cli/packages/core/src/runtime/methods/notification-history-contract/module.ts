export const moduleManifest = {
  id: "cli-background-notification-history",
  requires: ["zcode-cli"],
  provides: ["cli-background-notification-history"],
  publicEntrypoints: ["contract.ts"],
} as const;
