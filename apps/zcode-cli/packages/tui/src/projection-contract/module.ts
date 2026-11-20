export const moduleManifest = {
  id: "cli-tui-projection",
  requires: ["zcode-cli"],
  provides: ["cli-tui-projection"],
  publicEntrypoints: ["contract.ts"],
} as const;
