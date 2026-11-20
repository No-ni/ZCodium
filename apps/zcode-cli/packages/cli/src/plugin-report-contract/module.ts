export const moduleManifest = {
  id: "cli-plugin-install-report",
  requires: ["zcode-cli"],
  provides: ["cli-plugin-install-report"],
  publicEntrypoints: ["contract.ts"],
} as const;
