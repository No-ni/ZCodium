import type {
  ZCodeAvailablePluginSummary,
  ZCodeInstalledPluginSummary,
  ZCodePluginInfo,
  ZCodePluginStoreListing,
} from "@zcode/shared";
import { isExtensionEngineCompatible } from "@zcode/shared/extension-host";

/**
 * 商店条目：把 overview 的目录条目（listing/安装态）、运行时插件信息（启用态/组件）与
 * 已安装记录（更新徽标/安装时间）按 id join 成 UI 单一视图模型。
 */
export interface StorePluginItem {
  id: string;
  name: string;
  marketplace: string;
  installed: boolean;
  /** 已卸载的内置插件（可恢复）：安装按钮走 restoreBuiltin。 */
  restorable: boolean;
  /** 已安装但原 marketplace 已移除；仍可运行和管理，但不能更新。 */
  orphaned: boolean;
  listing?: ZCodePluginStoreListing;
  summary?: ZCodeAvailablePluginSummary;
  /** 运行时信息（仅已发现的已安装插件有）：启用态、组件、manifest 回退字段。 */
  info?: ZCodePluginInfo;
  installedMeta?: ZCodeInstalledPluginSummary;
}

// 市场和右侧推荐共用按插件的忙碌判定，避免安装一个插件时禁用整个推荐列表。
export function isItemBusy(
  item: StorePluginItem,
  actions: { activeOperations: ReadonlyArray<{ id: string }>; togglingPluginId: string | null },
): boolean {
  return (
    actions.activeOperations.some(
      (operation) => operation.id === `plugin:install:${item.name}@${item.marketplace}`,
    ) ||
    actions.activeOperations.some((operation) => operation.id === `plugin:restore:${item.id}`) ||
    actions.activeOperations.some((operation) => operation.id === `plugin:uninstall:${item.id}`) ||
    actions.activeOperations.some((operation) => operation.id === `plugin:update:${item.id}`) ||
    actions.activeOperations.some(
      (operation) => operation.id === `plugin:reset-config:${item.id}`,
    ) ||
    // 保存配置也是同插件写操作；漏掉它时恢复默认、更新可在保存期间被点击。
    actions.activeOperations.some((operation) => operation.id === `plugin:configure:${item.id}`) ||
    actions.togglingPluginId === item.id
  );
}

export type PluginUpdateStatus = NonNullable<ZCodeInstalledPluginSummary["updateStatus"]>;

export function isPluginUpdatePending(
  updateStatus: PluginUpdateStatus | undefined,
): updateStatus is Exclude<PluginUpdateStatus, "none"> {
  return updateStatus === "update-available" || updateStatus === "version-changed";
}

/**
 * 目录里的这一版带扩展，且本 App 的插件 API 版本跑不了它（docs/plugins/plugin-publishing.md §3.2、§4.3）。
 * 用扩展进程加载清单时的同一个判断；范围写法不认识时也算不兼容（新版 App 可能认识）。
 * 没有扩展摘要（不带扩展，或旧 CLI 没给）时不挡，装上后由扩展进程判「版本不兼容」。
 */
export function isExtensionIncompatible(
  listing: Pick<ZCodePluginStoreListing, "extensionSummary"> | undefined,
): boolean {
  const range = listing?.extensionSummary?.engines.zcode;
  return range !== undefined && !isExtensionEngineCompatible(range);
}

/** 未安装条目要先更新 ZCode 才能装。卡片、详情页按钮与 handleInstall 共用这一个判断。 */
export function isStoreItemInstallBlocked(
  item: Pick<StorePluginItem, "installed" | "restorable" | "listing">,
): boolean {
  return !item.installed && !item.restorable && isExtensionIncompatible(item.listing);
}

/**
 * CLI 只按版本号报更新；目录最新版不兼容时 App 不提示更新（§4.3）。
 * 已装插件的 listing 来自目录最新版条目，所以这里看的是最新版的扩展摘要。
 */
export function hasInstallableUpdate(
  summary: Pick<ZCodeInstalledPluginSummary, "updateStatus" | "listing"> | undefined,
): boolean {
  return isPluginUpdatePending(summary?.updateStatus) && !isExtensionIncompatible(summary?.listing);
}

/**
 * 孤立插件可能保留删除来源前的 updateStatus；若各入口只判断该缓存状态，
 * 详情页会在菜单已禁用更新时仍显示更新按钮。更新能力必须同时满足“来源存在”和“有可装的更新”。
 */
export function canUpdatePluginItem(
  item: Pick<StorePluginItem, "installedMeta" | "orphaned"> | null | undefined,
): boolean {
  return Boolean(item && !item.orphaned && hasInstallableUpdate(item.installedMeta));
}

/**
 * 「全部更新」每轮读 store 判断是否仍需更新：updateStatus 要等 loadInto 结束才变 none，
 * 行内更新已发出但未结束时只能靠 activeOperations 识别，否则同一插件会并发两次 plugins/update。
 */
export function needsPluginUpdate(
  state: {
    installedPlugins: readonly Pick<
      ZCodeInstalledPluginSummary,
      "id" | "updateStatus" | "listing"
    >[];
    activeOperations: readonly { id: string }[];
  },
  pluginId: string,
): boolean {
  if (state.activeOperations.some((operation) => operation.id === `plugin:update:${pluginId}`)) {
    return false;
  }
  return hasInstallableUpdate(state.installedPlugins.find((plugin) => plugin.id === pluginId));
}

/**
 * 「全部更新」：逐个等待单插件更新，单个失败（含抛错）不中断后续插件。
 * guard 读 store 当前状态：批量耗时较长，期间用户可能切换 Scope 或在行内先更新了某个插件。
 * 上下文变化即中止，且不计入切换期间完成的那一个（runWorkspaceOperation 此时返回 false，但可能已落盘）。
 */
export async function updatePluginsSerially(
  pluginIds: readonly string[],
  update: (pluginId: string) => Promise<boolean>,
  guard: { isCurrent: () => boolean; needsUpdate: (pluginId: string) => boolean },
): Promise<{ succeeded: string[]; failed: string[]; aborted: boolean }> {
  const succeeded: string[] = [];
  const failed: string[] = [];
  for (const pluginId of pluginIds) {
    if (!guard.isCurrent()) return { succeeded, failed, aborted: true };
    if (!guard.needsUpdate(pluginId)) continue;
    const ok = await update(pluginId).catch(() => false);
    if (!guard.isCurrent()) return { succeeded, failed, aborted: true };
    (ok ? succeeded : failed).push(pluginId);
  }
  return { succeeded, failed, aborted: false };
}
