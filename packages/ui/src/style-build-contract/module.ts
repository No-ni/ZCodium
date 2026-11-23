/**
 * ui-style-build 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const uiStyleBuildModule = {
  id: "ui-style-build",
  requires: [],
  provides: ["ui-style-build"],
  publicEntrypoints: ["../../lucide-colors.mjs", "contract.ts"],
} as const;
