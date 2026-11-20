export const moduleManifest = {
  id: "cli-turn-input-preparation",
  requires: ["zcode-cli", "turn-tool-visibility", "tool-discovery", "project-memory-runtime"],
  provides: ["cli-turn-input-preparation"],
  publicEntrypoints: ["contract.ts"],
} as const;
