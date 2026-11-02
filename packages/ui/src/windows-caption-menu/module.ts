export const windowsCaptionMenuModule = {
  id: "windows-caption-menu",
  requires: ["shared", "ui"],
  provides: ["windows-caption-menu"],
  publicEntrypoints: ["contract.ts"],
} as const;
