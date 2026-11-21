export const turnToolVisibilityModule = {
  id: "turn-tool-visibility",
  requires: ["agent-contracts", "zcode-cli"],
  provides: ["turn-tool-visibility"],
  publicEntrypoints: ["contract.ts"],
} as const;
