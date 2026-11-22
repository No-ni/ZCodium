export const sourceWorkspaceAliasRepoModule = {
  id: "source-workspace-alias-repo",
  requires: ["shared"],
  provides: ["source-workspace-alias-repo"],
  publicEntrypoints: ["contract.ts"],
} as const;
