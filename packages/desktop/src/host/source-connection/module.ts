/**
 * desktop-source-connection 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 * 本目录只放契约四件套；物理连接、目录与 Bot 适配仍是同模块既有的
 * sourceServerConnectionManager.ts / sourceServerDirectory.ts / botProjectBridge.ts。
 */
export const desktopSourceConnectionModule = {
  id: "desktop-source-connection",
  requires: ["bot-project-runtime", "desktop", "rpc", "server", "services", "shared"],
  provides: ["desktop-source-connection"],
  publicEntrypoints: ["contract.ts"],
} as const;
