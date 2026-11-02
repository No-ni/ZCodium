import type { PluginDataSyncPayload, PluginOptionSyncValue } from "@zcode/shared";

export type MarketplaceSourcePayload =
  | { kind: "official" }
  | { kind: "network"; input: string }
  | { kind: "mirror"; archive: Uint8Array }
  /** 来源端无法准备（来源类型不支持、镜像导出失败）；只影响需要准备来源的项。 */
  | { kind: "unavailable"; error: string };

export interface MarketplacePluginSyncPayload {
  items: Array<{
    key: string;
    pluginId: string;
    pluginName: string;
    marketplace: string;
    version?: string;
    enabled: boolean;
    /** 来源端按自己的 schema 筛过的安全 options；目标端按自己的 schema 再筛一次。 */
    options: Record<string, PluginOptionSyncValue>;
  }>;
  sources: Record<string, MarketplaceSourcePayload>;
}

/** 插件分类的组合 payload：inline 插件走 pluginSyncService，marketplace 插件走 Agent 编排。 */
export interface PluginCategorySyncPayload {
  inline?: PluginDataSyncPayload;
  marketplace?: MarketplacePluginSyncPayload;
}
