export const moduleManifest = {
  id: "cli-session-repository-support",
  requires: ["agent-contracts", "zcode-cli"],
  provides: ["cli-session-repository-support"],
  publicEntrypoints: ["contract.ts"],
} as const;
