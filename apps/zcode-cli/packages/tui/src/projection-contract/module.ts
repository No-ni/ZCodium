export const moduleManifest = {
  id: "cli-tui-projection",
  requires: ["agent-contracts", "zcode-cli"],
  provides: ["cli-tui-projection"],
  publicEntrypoints: ["contract.ts"],
} as const;
