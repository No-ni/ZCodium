/**
 * cli-test-config 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const cliTestConfigModule = {
  id: "cli-test-config",
  requires: [],
  provides: ["cli-test-config"],
  publicEntrypoints: ["../vitest.config.ts", "contract.ts"],
} as const;
