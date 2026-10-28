export const windowProjectDirectoryModule = {
  id: "window-project-directory",
  requires: ["shared", "rpc", "services"],
  publicEntrypoints: ["contract.ts", "index.ts"],
  layers: { domain: "domain", app: "app" },
  layerOrder: ["domain", "app"],
} as const;
