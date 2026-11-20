export const moduleManifest = {
  id: "memory-settings-ui",
  requires: ["ui", "shared", "services", "settings-scope", "provider"],
  provides: ["memory-settings-ui"],
  publicEntrypoints: ["contract.ts"],
} as const;
