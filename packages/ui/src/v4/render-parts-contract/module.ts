export const conversationRenderPartsModule = {
  id: "conversation-render-parts",
  requires: ["session-tool-presentation", "plugin-ui", "shared", "ui", "ui-file-menu", "services"],
  provides: ["conversation-render-parts"],
  publicEntrypoints: ["contract.ts"],
} as const;
