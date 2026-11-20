import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { useShallow } from "zustand/react/shallow";
import { type ExtensionAuditEntry, type ExtensionGrantState } from "@zcode/shared/extension-host";
import type { IExtensionGrantsService } from "@zcode/services";
import { useOptionalBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";
import {
  getExtensionGrantsStore,
  type ExtensionGrantsState,
} from "@/extension-slots/app/extensionGrantsStore.js";

// 扩展授权的 Renderer 入口（docs/plugins/extension-host.md §17.7）：授权状态的最近一份、授权对话框、撤销、
// 启用确认与「最近操作」。门面只在桌面本机 Host 注册；Web 与手机远控没有它，这些入口不显示。
// 两个对话框复用全局 ConfirmDialog（同一套样式与键盘行为），不另做弹窗组件。

const EMPTY_STORE = createStore<ExtensionGrantsState>(() => ({ snapshot: null }));

export function useExtensionGrantsService(): IExtensionGrantsService | null {
  return useOptionalBaseWorkspaceServices()?.extensionGrantsService ?? null;
}

/** 订阅授权状态，按 selector 取值（浅比较）。 */
export function useExtensionGrantsState<T>(selector: (state: ExtensionGrantsState) => T): T {
  const service = useExtensionGrantsService();
  const entry = service ? getExtensionGrantsStore(service) : null;
  useEffect(() => entry?.retain(), [entry]);
  return useStore(entry?.store ?? EMPTY_STORE, useShallow(selector));
}

/** 一个插件的授权状态；没有声明档位、也没有记录时为 null。 */
export function useExtensionGrantState(pluginId: string): ExtensionGrantState | null {
  return useExtensionGrantsState(
    (state) => state.snapshot?.plugins.find((plugin) => plugin.pluginId === pluginId) ?? null,
  );
}

/**
 * 「最近操作」：读该插件最近的审计行。授权状态（rev）变化时重新读：P3a 的审计行只有授权与撤销，
 * 都会改变授权状态，所以不需要轮询。
 */
export function useExtensionRecentActions(pluginId: string): ExtensionAuditEntry[] | null {
  const service = useExtensionGrantsService();
  const rev = useExtensionGrantsState((state) => state.snapshot?.rev ?? null);
  const [result, setResult] = useState<{
    pluginId: string;
    entries: ExtensionAuditEntry[];
  } | null>(null);
  useEffect(() => {
    if (!service || rev === null) return;
    let cancelled = false;
    void service.getRecentActions({ pluginId, limit: 10 }).then(
      ({ entries }) => {
        if (!cancelled) setResult({ pluginId, entries });
      },
      (error: unknown) => {
        logger.lifecycle.warn("[extension-slots] recent actions failed", {
          pluginId,
          name: error instanceof Error ? error.name : typeof error,
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [pluginId, rev, service]);
  // rev 换了、新结果还没到时沿用同一插件的上一份，避免列表闪空；换了插件不沿用。
  return result?.pluginId === pluginId ? result.entries : null;
}
export { EMPTY_STORE };
