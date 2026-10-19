import { useEffect, useRef } from "react";
import { createPluginUiInstancePublisher } from "../app/pluginUiInstanceStore.js";
import type { PluginUiInstanceDerivation } from "../domain/pluginUiInstancePolicy.js";

export function usePublishPluginUiInstanceDerivation(
  sessionKey: string,
  derivation: PluginUiInstanceDerivation,
): void {
  const publisher = useRef<ReturnType<typeof createPluginUiInstancePublisher> | null>(null);
  useEffect(() => {
    const current = createPluginUiInstancePublisher(sessionKey);
    publisher.current = current;
    return () => {
      current.dispose();
      if (publisher.current === current) publisher.current = null;
    };
  }, [sessionKey]);
  // 发布者生命周期与内容更新分离，正文续写不能先清空裁决、让卡片闪过 absent 状态。
  useEffect(() => {
    publisher.current?.set(derivation);
  }, [sessionKey, derivation]);
}
