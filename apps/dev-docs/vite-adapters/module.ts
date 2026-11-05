export const devDocsViteAdaptersModule = {
  id: "dev-docs-vite-adapters",
  requires: ["dev-docs-legacy"],
  provides: ["developer-docs-vite-plugins"],
  publicEntrypoints: ["index.ts", "contract.ts", "../vite.config.ts"],
} as const;
