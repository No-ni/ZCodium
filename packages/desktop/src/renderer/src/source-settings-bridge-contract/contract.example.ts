import type { DesktopSourceSettingsBridgeEntry1 } from "./contract.js";
/** 调用方持有既有入口；示例只转交一次相同意图，不装配进程或读真实目录。 */
export function exampleDesktopSourceSettingsBridge(
  api: DesktopSourceSettingsBridgeEntry1,
  ...args: Parameters<DesktopSourceSettingsBridgeEntry1["handleSourceSettingsServicePortMessage"]>
): ReturnType<DesktopSourceSettingsBridgeEntry1["handleSourceSettingsServicePortMessage"]> {
  return api.handleSourceSettingsServicePortMessage(...args);
}
