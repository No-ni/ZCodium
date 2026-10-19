import {
  EMPTY_PLUGIN_UI_INSTANCE_DERIVATION,
  type PluginUiInstanceDerivation,
  type PluginUiRowDisposition,
} from "../domain/pluginUiInstancePolicy.js";

/**
 * 每个会话最近一次由时间线推导出的逻辑 UI 裁决（renderer 内存）。时间线在 effect 里写入，
 * 工具卡片按 (sessionKey, toolCallId) 读自己的裁决（是否被替代、是否强制常驻）；不持有任何沙箱状态。
 */
const derivations = new Map<string, Map<object, PluginUiInstanceDerivation>>();
const listeners = new Set<() => void>();

function current(sessionKey: string): PluginUiInstanceDerivation | undefined {
  const publishers = derivations.get(sessionKey);
  let latest: PluginUiInstanceDerivation | undefined;
  // 每张卡片读快照都会经过这里，无需为查最后一个活发布者复制整个数组。
  if (publishers) for (const derivation of publishers.values()) latest = derivation;
  return latest;
}

export function createPluginUiInstancePublisher(sessionKey: string) {
  const owner = {};
  let disposed = false;
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    set(derivation: PluginUiInstanceDerivation) {
      if (disposed) return;
      const previous = current(sessionKey);
      const publishers = derivations.get(sessionKey) ?? new Map();
      // 同会话可有多个 Timeline；更新移动到队尾，释放旧视图不能删除另一个活视图的快照。
      publishers.delete(owner);
      publishers.set(owner, derivation);
      derivations.set(sessionKey, publishers);
      if (previous !== derivation) notify();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const previous = current(sessionKey);
      const publishers = derivations.get(sessionKey);
      publishers?.delete(owner);
      // 裁决是视图派生值；最后一个发布者离开即释放，不随历史会话数量永久增长。
      if (publishers?.size === 0) derivations.delete(sessionKey);
      if (current(sessionKey) !== previous) notify();
    },
  };
}

export function getPluginUiRowDisposition(
  sessionKey: string,
  toolCallId: string,
): PluginUiRowDisposition | undefined {
  return (current(sessionKey) ?? EMPTY_PLUGIN_UI_INSTANCE_DERIVATION).byToolCallId[toolCallId];
}

export function subscribePluginUiInstances(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 测试用：清空全部记录。 */
export function resetPluginUiInstancesForTest(): void {
  derivations.clear();
  listeners.clear();
}
