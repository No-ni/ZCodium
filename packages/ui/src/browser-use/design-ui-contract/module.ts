export const moduleManifest = {
  id: "browser-design-ui",
  requires: ["ui", "shared", "services", "design-runtime", "settings-scope"],
  provides: ["browser-design-ui"],
  publicEntrypoints: ["contract.ts"],
} as const;
