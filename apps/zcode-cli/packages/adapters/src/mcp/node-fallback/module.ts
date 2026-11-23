export const cliMcpNodeFallbackModule = {
  id: "cli-mcp-node-fallback",
  requires: ["shared", "agent-contracts", "zcode-cli"],
  provides: ["cli-mcp-node-fallback"],
  publicEntrypoints: ["../node-fallback.ts", "contract.ts"],
} as const;
