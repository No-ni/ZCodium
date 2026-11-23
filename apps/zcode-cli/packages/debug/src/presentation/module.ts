/**
 * cli-debug-presentation 模块清单（architecture-governance managed 模块）。
 * 层：ui。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const cliDebugPresentationModule = {
  id: "cli-debug-presentation",
  requires: ["zcode-cli"],
  provides: ["cli-debug-presentation"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
