export const modelRequestCompressionModule = {
  id: "model-request-compression",
  requires: ["agent-contracts", "zcode-cli"],
  provides: ["model-request-compression"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
