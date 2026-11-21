export const moduleManifest = {
  id: "cli-session-input-intent",
  requires: ["agent-contracts", "gen-ui-protocol", "shared", "zcode-cli"],
  provides: ["cli-session-input-intent"],
  publicEntrypoints: ["contract.ts"],
} as const;
