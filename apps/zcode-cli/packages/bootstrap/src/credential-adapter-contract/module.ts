export const moduleManifest = {
  id: "cli-protocol-credential-adapter",
  requires: ["zcode-cli", "shared", "credential-security"],
  provides: ["cli-protocol-credential-adapter"],
  publicEntrypoints: ["contract.ts"],
} as const;
