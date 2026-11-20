import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { useScopedPluginManagementStore } from "@/store/pluginManagementStore.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { requestPluginStoreOpen } from "@/lib/pluginStoreNavigation.js";
import { logger } from "@/logger.js";
import { toast } from "@/components/ui/toast.js";
import type { DesignChipTarget } from "./browserDesignTarget.js";
const DESIGN_PLUGIN_ID = "design@zcode-plugins-official";
export function useBrowserDesignPlugin({
  chipTarget,
  remoteSessionId,
  workspaceIdentity,
  probeEnabled,
  isVisible,
  pageKey,
}: {
  chipTarget: DesignChipTarget | null;
  remoteSessionId?: string | null;
  workspaceIdentity?: string;
  probeEnabled: boolean;
  isVisible: boolean;
  pageKey: string;
}) {
  const { intl } = useZCodeIntl();
  // 元素引用的 workspaceKey 在本地也有值，不能把它当远程身份，否则本地查询会走断连代理。
  const {
    services: { pluginManagementService },
    rpcReady,
  } = useWorkspaceServicesResolution(chipTarget?.workspacePath, remoteSessionId, workspaceIdentity);
  const pluginStore = useScopedPluginManagementStore(pluginManagementService);
  const pluginEnabled = pluginStore(
    (state) =>
      state.workspacePath === chipTarget?.workspacePath &&
      state.workspaceIdentity === (workspaceIdentity?.trim() || null) &&
      state.plugins.some((plugin) => plugin.id === DESIGN_PLUGIN_ID && plugin.enabled),
  );
  const initializePlugin = useCallback(async () => {
    if (!probeEnabled || !chipTarget || !rpcReady) return;
    await pluginStore.getState().initialize({
      workspacePath: chipTarget.workspacePath,
      workspaceIdentity,
      pluginService: pluginManagementService,
    });
  }, [chipTarget, pluginManagementService, pluginStore, probeEnabled, rpcReady, workspaceIdentity]);
  useEffect(() => {
    void initializePlugin();
  }, [initializePlugin]);
  const confirm = useConfirmDialog();
  const pendingSelection = useRef<AbortController | null>(null);
  useLayoutEffect(
    () => () => {
      // 插件查询和安装提示属于发起的 tab/页面；切换后不能用旧结果导航或进入点选。
      pendingSelection.current?.abort();
      pendingSelection.current = null;
    },
    [chipTarget, isVisible, pageKey, pluginManagementService, workspaceIdentity],
  );
  const requestPluginSelection = useCallback(
    async (select: () => void, isSelecting: boolean) => {
      if (!isVisible || !probeEnabled || pendingSelection.current) return;
      if (isSelecting) {
        select();
        return;
      }
      const controller = new AbortController();
      pendingSelection.current = controller;
      try {
        await initializePlugin();
        if (controller.signal.aborted) return;
        const state = pluginStore.getState();
        if (!chipTarget || !rpcReady || state.error) {
          logger.warn("[browser-design] 无法读取 Design 插件状态", {
            rpcReady,
            error: state.error,
          });
          toast(intl.formatMessage({ id: "browser.design.pluginCheckFailed" }), {
            variant: "warning",
          });
          return;
        }
        if (state.plugins.some((plugin) => plugin.id === DESIGN_PLUGIN_ID && plugin.enabled)) {
          select();
          return;
        }
        const confirmed = await confirm(
          {
            title: intl.formatMessage({ id: "browser.design.pluginRequired.title" }),
            description: intl.formatMessage({ id: "browser.design.pluginRequired.description" }),
            confirmLabel: intl.formatMessage({ id: "browser.design.pluginRequired.action" }),
            testId: "browser-design-plugin-required",
            showKeyboardHints: false,
          },
          controller.signal,
        );
        if (confirmed && !controller.signal.aborted) requestPluginStoreOpen(DESIGN_PLUGIN_ID);
      } finally {
        if (pendingSelection.current === controller) pendingSelection.current = null;
      }
    },
    [chipTarget, confirm, initializePlugin, intl, isVisible, pluginStore, probeEnabled, rpcReady],
  );

  return { pluginEnabled, requestPluginSelection };
}
