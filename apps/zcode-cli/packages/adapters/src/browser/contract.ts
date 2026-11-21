/** standalone CLI 的既有 CDP adapter 公共面；工厂本身不启动浏览器。 */
export {
  createManagedCdpBrowserRuntime,
  resolveInstalledBrowserExecutable,
  validateExplicitBrowserExecutable,
  isAllowedManagedBrowserUrl,
} from "./index.js";
export type {
  ManagedCdpBrowserRuntimeOptions,
  ManagedCdpBrowserRuntime,
  BrowserExecutableResolutionOptions,
  PlaywrightChromiumModule,
} from "./index.js";
