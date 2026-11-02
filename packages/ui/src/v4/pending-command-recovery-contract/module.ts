export const pendingCommandRecoveryModule = {
  id: "pending-command-recovery",
  requires: ["shared", "ui"],
  provides: ["pending-command-recovery"],
  publicEntrypoints: ["contract.ts"],
} as const;
