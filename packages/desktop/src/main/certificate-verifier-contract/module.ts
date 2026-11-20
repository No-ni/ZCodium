export const moduleManifest = {
  id: "desktop-certificate-verifier",
  requires: ["desktop", "shared"],
  provides: ["desktop-certificate-verifier"],
  publicEntrypoints: ["contract.ts"],
} as const;
