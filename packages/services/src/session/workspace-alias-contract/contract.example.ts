import { resolveSourceWorkspaceAliasStoragePaths } from "./contract.js";
/** 仅计算传给官方 Repo 的路径，调用方仍持有原迁移 owner。 */
export function exampleSourceWorkspaceAliasStorage(dataBaseDir: string) {
  return resolveSourceWorkspaceAliasStoragePaths(dataBaseDir);
}
