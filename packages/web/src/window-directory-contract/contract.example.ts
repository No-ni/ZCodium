import type { WebWindowDirectoryEntry } from "./contract.js";
/** 调用方持有当前 bootstrap 与 Host 目录；沿原接口做一次纯投影。 */
export function exampleWebWindowDirectory(
  api: WebWindowDirectoryEntry,
  ...args: Parameters<WebWindowDirectoryEntry["mergeMobileWindowDirectory"]>
): ReturnType<WebWindowDirectoryEntry["mergeMobileWindowDirectory"]> {
  return api.mergeMobileWindowDirectory(...args);
}
