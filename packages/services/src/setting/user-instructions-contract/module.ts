export const userInstructionsModule = {
  id: "user-instructions",
  requires: ["services", "shared"],
  provides: ["user-instructions"],
  publicEntrypoints: ["contract.ts"],
} as const;
