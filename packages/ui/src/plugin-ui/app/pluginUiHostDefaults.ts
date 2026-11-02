import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { PluginUiHostBridge } from "./pluginUiHostBridge.js";
import type { PluginUiHostControllerDeps } from "./pluginUiHostControllerContract.js";

/**
 * 握手超时 / teardown 等待的计时器：缺省 setTimeout。
 * 取消合同：返回的取消函数清除定时器，dispose 或握手完成后调用，迟到回调不触发。
 */
export function resolvePluginUiSetTimer(
  setTimer: PluginUiHostControllerDeps["setTimer"],
): NonNullable<PluginUiHostControllerDeps["setTimer"]> {
  return (
    setTimer ??
    ((callback: () => void, ms: number) => {
      const timer = setTimeout(callback, ms);
      return () => clearTimeout(timer);
    })
  );
}

/** 缺省 `new AppBridge(null, …)`：官方 ext-apps 每活页面一个桥；测试经 deps 注入假桥。 */
export function resolvePluginUiCreateAppBridge(
  createAppBridge: PluginUiHostControllerDeps["createAppBridge"],
): NonNullable<PluginUiHostControllerDeps["createAppBridge"]> {
  return (
    createAppBridge ??
    ((hostInfo, hostCapabilities, initialContext) =>
      new AppBridge(null, hostInfo, hostCapabilities, {
        hostContext: initialContext,
      }) as unknown as PluginUiHostBridge)
  );
}
