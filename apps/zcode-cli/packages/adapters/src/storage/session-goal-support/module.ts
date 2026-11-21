/**
 * cli-session-goal-support 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const cliSessionGoalSupportModule = {
  id: "cli-session-goal-support",
  requires: ["agent-contracts"],
  provides: ["cli-session-goal-support"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
