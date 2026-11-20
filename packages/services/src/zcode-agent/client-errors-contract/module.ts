export const moduleManifest = {
  id: "zcode-protocol-client-errors",
  requires: ["services", "shared", "rpc"],
  provides: ["zcode-protocol-client-errors"],
  publicEntrypoints: ["contract.ts"],
} as const;
