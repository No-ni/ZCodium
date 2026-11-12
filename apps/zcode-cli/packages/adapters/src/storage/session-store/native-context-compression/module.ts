/** CLI 压缩事实持久化；不得在这里增加模型执行、文件存储或另一份会话状态。 */
export const nativeContextStoreModule = {
  id: "native-context-store",
  requires: ["zcode-cli", "shared", "native-context-protocol", "sqlite-migrations"],
  provides: ["native-context-store"],
  publicEntrypoints: ["contract.ts", "index.ts"],
} as const;
