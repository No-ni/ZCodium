export const projectMemoryRuntimeModule = {
  id: "project-memory-runtime",
  requires: ["agent-contracts", "zcode-cli"],
  provides: ["project-memory-runtime"],
  publicEntrypoints: ["contract.ts"],
} as const;
