export const sidePaneFullViewModule = {
  id: "side-pane-full-view",
  requires: ["shared", "ui"],
  provides: ["side-pane-full-view"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
