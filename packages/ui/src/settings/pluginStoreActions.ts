import type { StorePluginItem } from "@/settings/pluginStoreListing.js";

/** 商店条目的通用动作集：列表卡片、详情页共用同一套回调与进行中态判定。 */
export interface PluginStoreActions {
  onOpenDetail: (pluginId: string) => void;
  onOpenUi?: (item: StorePluginItem) => void;
  /** 安装或恢复（restorable 内置插件走 restoreBuiltin，其余走 install）。 */
  onInstall: (item: StorePluginItem) => void;
  onUninstall: (pluginId: string) => void;
  onSetEnabled?: (pluginId: string, enabled: boolean) => void;
  /** 删除当前 Workspace scope 的显式配置，使其回退到 User。 */
  onResetConfig?: (pluginId: string) => void;
  onUpdate: (pluginId: string) => void;
  activeOperations: ReadonlyArray<{ id: string }>;
  togglingPluginId: string | null;
}
