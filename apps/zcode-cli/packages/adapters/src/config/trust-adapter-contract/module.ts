export const moduleManifest = {
  id: "cli-workspace-trust-adapter",
  requires: ["zcode-cli", "managed-worktree-shared"],
  provides: ["cli-workspace-trust-adapter"],
  publicEntrypoints: ["contract.ts"],
} as const;
