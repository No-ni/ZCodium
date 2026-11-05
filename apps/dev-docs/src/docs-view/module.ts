export const devDocsViewModule = {
  id: "dev-docs-view",
  requires: ["dev-docs-legacy"],
  provides: ["developer-docs-view"],
  publicEntrypoints: ["index.ts", "contract.ts", "../App.tsx"],
} as const;
