export const moduleManifest = {
  id: "bot-channel-types",
  requires: ["services", "shared", "credential-store"],
  provides: ["bot-channel-types"],
  publicEntrypoints: ["contract.ts"],
} as const;
