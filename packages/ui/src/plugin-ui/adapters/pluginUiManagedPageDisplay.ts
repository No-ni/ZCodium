import { appAllowsDisplayMode } from "../domain/buildPluginUiHostContext.js";
import type { McpUiAppCapabilities } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { UsePluginUiHostInput } from "./pluginUiHostTypes.js";
import type { createPluginUiPagePlane } from "./pluginUiPagePlane.js";
export function syncManagedPageDisplayModes(
  plane: ReturnType<typeof createPluginUiPagePlane>,
  latest: { current: UsePluginUiHostInput },
  appCapabilities: McpUiAppCapabilities | undefined,
) {
  // 能力只有握手后才可知；之前在后台加载，避免 fullscreen-only 页面先闪现 inline。
  plane.setAllowedDisplayModes(
    appCapabilities === undefined
      ? []
      : (["inline", "fullscreen"] as const).filter((mode) =>
          appAllowsDisplayMode(
            appCapabilities,
            mode,
            latest.current.presentation.preferredDisplayMode,
          ),
        ),
  );
}

import { PLUGIN_UI_CARD_DEFAULT_HEIGHT_PX } from "../contract.js";
import type { UsePluginUiHostResult } from "./pluginUiHostTypes.js";
export function initialManagedPageSnapshot(key: string, reload: () => void): UsePluginUiHostResult {
  return {
    pageKey: key,
    supported: true,
    phase: "idle",
    handle: null,
    height: PLUGIN_UI_CARD_DEFAULT_HEIGHT_PX,
    error: null,
    appCapabilities: undefined,
    reload,
  };
}
