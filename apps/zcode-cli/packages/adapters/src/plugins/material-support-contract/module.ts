export const moduleManifest = {
  id: "cli-plugin-material-support",
  requires: ["zcode-cli"],
  provides: ["cli-plugin-material-support"],
  publicEntrypoints: ["contract.ts"],
} as const;
