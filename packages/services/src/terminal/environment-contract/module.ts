export const moduleManifest = {
  id: "terminal-environment",
  requires: ["services", "shared"],
  provides: ["terminal-environment"],
  publicEntrypoints: ["contract.ts"],
} as const;
