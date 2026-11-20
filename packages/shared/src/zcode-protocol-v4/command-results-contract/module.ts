export const moduleManifest = {
  id: "command-results-protocol",
  requires: ["shared", "local-ttft-contract"],
  provides: ["command-results-protocol"],
  publicEntrypoints: ["contract.ts"],
} as const;
