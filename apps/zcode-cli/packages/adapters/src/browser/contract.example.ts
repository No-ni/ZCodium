import {
  createManagedCdpBrowserRuntime,
  type ManagedCdpBrowserRuntimeOptions,
  type ManagedCdpBrowserRuntime,
} from "./contract.js";

/** 调用方注入 executable/Playwright loader；只创建原 runtime，启动由原 list/execute 决定。 */
export function exampleManagedCdpBrowser(
  options: ManagedCdpBrowserRuntimeOptions,
): ManagedCdpBrowserRuntime {
  return createManagedCdpBrowserRuntime(options);
}
