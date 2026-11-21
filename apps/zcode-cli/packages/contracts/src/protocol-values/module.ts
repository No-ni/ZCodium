/**
 * agent-protocol-values 模块清单（architecture-governance managed 模块）。
 * 层：contract。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const agentProtocolValuesModule = {
  id: "agent-protocol-values",
  requires: [],
  provides: ["agent-protocol-values"],
  publicEntrypoints: ["contract.ts", "model-contract.ts", "workflow-contract.ts"],
} as const;
