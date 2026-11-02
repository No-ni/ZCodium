import type { WebThemeSeedEntry1 } from "./contract.js";
/** 调用方持有既有入口；示例只转交一次相同意图，不装配进程或读真实目录。 */
export function exampleWebThemeSeed(
  api: WebThemeSeedEntry1,
  ...args: Parameters<WebThemeSeedEntry1["resolveWebInitialTheme"]>
): ReturnType<WebThemeSeedEntry1["resolveWebInitialTheme"]> {
  return api.resolveWebInitialTheme(...args);
}
