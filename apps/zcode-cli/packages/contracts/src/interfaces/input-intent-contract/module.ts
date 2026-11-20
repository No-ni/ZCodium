export const moduleManifest = {
  id: "cli-session-input-intent",
  requires: ["zcode-cli", "gen-ui-protocol"],
  provides: ["cli-session-input-intent"],
  publicEntrypoints: ["contract.ts"],
} as const;
