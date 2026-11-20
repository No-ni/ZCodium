export const moduleManifest = {
  id: "cli-config-diagnostics",
  requires: ["zcode-cli"],
  provides: ["cli-config-diagnostics"],
  publicEntrypoints: ["contract.ts"],
} as const;
