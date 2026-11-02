import type { ISourceServerManagementService } from "@zcode/services";
import { logger } from "@/logger.js";

export interface SourceServerDisplayNameRegistry {
  subscribe(listener: () => void): () => void;
  getSnapshot(): ReadonlyMap<string, string>;
}

const registries = new WeakMap<ISourceServerManagementService, SourceServerDisplayNameRegistry>();

export function getSourceServerDisplayNameRegistry(
  management: ISourceServerManagementService,
): SourceServerDisplayNameRegistry {
  const existing = registries.get(management);
  if (existing) return existing;
  const listeners = new Set<() => void>();
  let names: ReadonlyMap<string, string> = new Map();
  let refreshInFlight: Promise<void> | null = null;
  let refreshQueued = false;
  const refresh = () => {
    if (refreshInFlight) {
      refreshQueued = true;
      return;
    }
    refreshInFlight = management
      .getSnapshot()
      .then((snapshot) => {
        names = new Map(
          snapshot.directory.servers.map((server) => [server.sourceServerId, server.displayName]),
        );
        for (const listener of listeners) listener();
      })
      .catch(() => {
        logger.warn("[sourceServerDisplayNameRegistry] 读取 Source 目录失败");
      })
      .finally(() => {
        refreshInFlight = null;
        if (refreshQueued) {
          refreshQueued = false;
          refresh();
        }
      });
  };
  // 名称与状态同源读取 directory/states，不订阅已退休的并列事件。
  management.onDidChange(refresh);
  refresh();
  const registry: SourceServerDisplayNameRegistry = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => names,
  };
  registries.set(management, registry);
  return registry;
}
