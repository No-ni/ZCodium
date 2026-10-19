import { useSyncExternalStore } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  getPluginUiRowDisposition,
  subscribePluginUiInstances,
} from "../app/pluginUiInstanceStore.js";

export function usePluginUiRowDisposition(sessionKey: string, toolCallId: string) {
  // 正文续写也会重建裁决对象；全部字段相同时复用本 hook 的快照，避免无关卡片重渲染。
  const getSnapshot = useShallow((_state: void) =>
    getPluginUiRowDisposition(sessionKey, toolCallId),
  );
  return useSyncExternalStore(subscribePluginUiInstances, getSnapshot, () => undefined);
}
