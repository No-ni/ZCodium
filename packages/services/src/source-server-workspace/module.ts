export const sourceServerWorkspaceModule = {
  id: "source-server-workspace",
  requires: ["shared", "sqlite-migrations"],
  publicEntrypoints: ["contract.ts", "inspection-contract.ts", "index.ts", "node.ts"],
  owner: "remote-workspace",
  layers: ["domain", "app", "adapters"],
} as const;
