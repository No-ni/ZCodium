export const moduleManifest = {
  id: "cli-runtime-context-support",
  requires: ["agent-contracts", "zcode-cli"],
  provides: ["cli-runtime-context-support"],
  publicEntrypoints: ["contract.ts"],
} as const;
