export const conversationRenderPartsModule = {
  id: "conversation-render-parts",
  requires: ["plugin-ui", "shared", "ui", "ui-file-menu"],
  provides: ["conversation-render-parts"],
  publicEntrypoints: ["contract.ts"],
} as const;
