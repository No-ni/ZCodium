/**
 * office-runtime managed 清单；与 architecture-policy.yaml 的 owner、依赖和公共入口一致。
 * 独立插件包沿固定官方 app 层治理，构建消费通过公开 contract，不承载宿主会话状态。
 */
export const officeRuntimeModule = {
  id: "office-runtime",
  owner: "plugin",
  layers: { app: "." },
  requires: [],
  provides: ["office-runtime"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
