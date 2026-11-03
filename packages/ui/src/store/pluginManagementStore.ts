import { useEffect, useMemo } from "react";
import { create } from "zustand";
import type { ZCodePluginDiagnostic } from "@zcode/shared";
import { CLAUDE_OFFICIAL_PLUGIN_MARKETPLACE_ID } from "@zcode/shared";
import type { IPluginManagementService } from "@zcode/services";
import { logger } from "@/logger.js";
import {
  beginPluginOperation,
  loadInto,
  runWorkspaceOperation,
  subscribePluginManagementChanges,
  isPluginManagementChangeRelevant,
  notifyPluginManagementChange,
} from "@/store/pluginManagementStoreLoading.js";
import { setPluginEnabledOptimistically } from "@/store/pluginManagementStoreEnabled.js";

// 类型拆出以保持行数契约；Store 的请求、服务权威和订阅仍由当前文件唯一持有。
import type { PluginDescribeEntry, PluginManagementState } from "./state-contracts/contract.js";
export type { PluginDescribeEntry, PluginManagementState } from "./state-contracts/contract.js";

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwForErrorDiagnostic(diagnostics: ZCodePluginDiagnostic[]): void {
  const blockingDiagnostic = diagnostics.find((diagnostic) => diagnostic.severity === "error");
  if (blockingDiagnostic) {
    throw new Error(blockingDiagnostic.message);
  }
}

export const createPluginManagementStore = (initialService?: IPluginManagementService) => {
  let lastService = initialService;
  return create<PluginManagementState>((set, get) => ({
    workspacePath: null,
    workspaceIdentity: null,
    authorityKey: null,
    configScope: null,
    plugins: [],
    marketplaces: [],
    marketplaceAvailabilityKnown: false,
    availablePlugins: [],
    installedPlugins: [],
    restorableBuiltins: [],
    diagnostics: [],
    loading: false,
    error: null,
    lastFailedPluginId: null,
    togglingPluginId: null,
    activeOperations: [],
    operationVersion: 0,
    describeCache: {},

    async initialize({
      workspacePath,
      workspaceIdentity,
      authorityKey,
      configScope,
      pluginService,
    }) {
      lastService = pluginService;
      const normalizedIdentity = workspaceIdentity?.trim() || null;
      const normalizedAuthorityKey = authorityKey?.trim() || null;
      const normalizedConfigScope = configScope ?? null;
      const current = get();
      const contextChanged =
        current.workspacePath !== workspacePath ||
        current.workspaceIdentity !== normalizedIdentity ||
        current.authorityKey !== normalizedAuthorityKey ||
        current.configScope !== normalizedConfigScope;
      const hasCache =
        current.plugins.length > 0 &&
        current.workspacePath === workspacePath &&
        current.workspaceIdentity === normalizedIdentity &&
        current.authorityKey === normalizedAuthorityKey &&
        current.configScope === normalizedConfigScope;
      set({
        workspacePath,
        workspaceIdentity: normalizedIdentity,
        authorityKey: normalizedAuthorityKey,
        configScope: normalizedConfigScope,
        // 有缓存时后台刷新、保留列表, 避免切换 workspace 时闪烁; 无缓存才显示阻塞 loading。
        loading: !hasCache,
        marketplaceAvailabilityKnown: hasCache ? current.marketplaceAvailabilityKnown : false,
        error: null,
        lastFailedPluginId: null,
        // 配置保存后的 overview 刷新可能还没结束，用户已切到另一层配置视图；
        // 旧层的 activeOperations 不能继续把新层的输入控件置灰。旧操作结束时由独立条目防止
        // 它误清理新层后来启动的同名操作。
        // 先清空旧目标的投影，避免新项目加载期间仍能操作旧项目卡片或复用 describe 缓存。
        ...(contextChanged
          ? {
              activeOperations: [],
              operationVersion: current.operationVersion + 1,
              togglingPluginId: null,
              plugins: [],
              marketplaces: [],
              availablePlugins: [],
              installedPlugins: [],
              restorableBuiltins: [],
              diagnostics: [],
              describeCache: {},
            }
          : {}),
      });
      await loadInto(set, get, {
        workspacePath,
        workspaceIdentity: normalizedIdentity,
        authorityKey: normalizedAuthorityKey,
        configScope: normalizedConfigScope,
        pluginService,
      });
    },

    async refresh(pluginService = lastService, options = {}) {
      const { workspacePath, workspaceIdentity, authorityKey, configScope } = get();
      if (!workspacePath || !pluginService) return;
      lastService = pluginService;
      if (!options.background) set({ error: null, lastFailedPluginId: null });
      await loadInto(set, get, {
        workspacePath,
        workspaceIdentity,
        authorityKey,
        configScope,
        pluginService,
        fresh: !options.background,
        background: options.background,
      });
      if (!options.background)
        notifyPluginManagementChange({
          owner: get,
          workspacePath,
          workspaceIdentity,
          authorityKey,
          scope: "user",
        });
    },

    async addMarketplace(source, pluginService) {
      return runWorkspaceOperation(
        set,
        get,
        pluginService,
        `marketplace:add:${source}`,
        async (workspace) => {
          await pluginService.addPluginMarketplace({
            ...workspace,
            source,
          });
        },
      );
    },

    async updateMarketplace(marketplace, pluginService) {
      let refreshError: string | null = null;
      const succeeded = await runWorkspaceOperation(
        set,
        get,
        pluginService,
        `marketplace:update:${marketplace ?? "__all__"}`,
        async (workspace) => {
          const result = await pluginService.updatePluginMarketplace({
            ...workspace,
            ...(marketplace ? { marketplace } : {}),
          });
          // 刷新允许部分成功，因此仍要 reload overview 保留成功来源；但仅 warn
          // 并返回 true，桌面与手机 Web 都会把旧快照误报成刷新成功。先记住错误，reload 后再写入
          // 共用 store 的可见错误态，同时返回 false，让所有入口获得一致的部分失败语义。
          const blockingDiagnostic = result.diagnostics?.find(
            (diagnostic) =>
              diagnostic.severity === "error" &&
              diagnostic.pluginId !== CLAUDE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
          );
          if (blockingDiagnostic) {
            refreshError = blockingDiagnostic.message;
            logger.warn("[plugins] marketplace refresh partially failed", {
              diagnostics: result.diagnostics,
            });
          }
        },
      );
      if (succeeded && refreshError) {
        // 列表刷新失败无插件目标，归属清空（不指向任何插件）。
        set({ error: refreshError, lastFailedPluginId: null });
        return false;
      }
      return succeeded;
    },

    async removeMarketplace(marketplace, pluginService) {
      await runWorkspaceOperation(
        set,
        get,
        pluginService,
        `marketplace:remove:${marketplace}`,
        async (workspace) => {
          await pluginService.removePluginMarketplace({
            ...workspace,
            marketplace,
          });
        },
      );
    },

    async installPlugin(pluginName, marketplace, pluginService, scope = "user") {
      return runWorkspaceOperation(
        set,
        get,
        pluginService,
        `plugin:install:${pluginName}@${marketplace}`,
        async (workspace) => {
          const result = await pluginService.installPlugin({
            ...workspace,
            pluginName,
            marketplace,
            scope,
          });
          // CLI 为了保留结构化诊断，安装失败会返回成功的 RPC envelope，
          // 并把实际错误放进 diagnostics。旧 UI 忽略返回值后继续刷新，看起来像按钮无响应，
          // 也没有错误和重试入口；这里将 error diagnostic 收敛到既有 operation 错误态。
          throwForErrorDiagnostic(result.diagnostics);
        },
      );
    },

    async uninstallPlugin(pluginId, pluginService, removeCache = true) {
      await runWorkspaceOperation(
        set,
        get,
        pluginService,
        `plugin:uninstall:${pluginId}`,
        async (workspace) => {
          await pluginService.uninstallPlugin({
            ...workspace,
            pluginId,
            removeCache,
          });
        },
      );
    },

    async updatePlugin(pluginId, pluginService) {
      return runWorkspaceOperation(
        set,
        get,
        pluginService,
        `plugin:update:${pluginId}`,
        async (workspace) => {
          const result = await pluginService.updatePlugin({ ...workspace, pluginId });
          // update 与 install 共享同一诊断式失败契约。抛入 runWorkspaceOperation 后不会
          // 覆盖当前 overview，因此旧版本和 update badge 会一直保留到用户重试成功。
          throwForErrorDiagnostic(result.diagnostics);
        },
      );
    },

    async restoreBuiltin(pluginId, pluginService) {
      return runWorkspaceOperation(
        set,
        get,
        pluginService,
        `plugin:restore:${pluginId}`,
        async (workspace) => {
          const result = await pluginService.restoreBuiltinPlugin({ ...workspace, pluginId });
          throwForErrorDiagnostic(result.diagnostics);
        },
      );
    },

    async configurePlugin(pluginId, options, pluginService, scope = "user", clearOptionKeys = []) {
      return await runWorkspaceOperation(
        set,
        get,
        pluginService,
        `plugin:configure:${pluginId}`,
        async (workspace) => {
          await pluginService.configurePlugin({
            ...workspace,
            pluginId,
            options,
            scope,
            ...(clearOptionKeys.length > 0 ? { clearOptionKeys } : {}),
          });
        },
        scope,
      );
    },

    async resetPluginConfig(pluginId, pluginService, scope = "workspace") {
      return await runWorkspaceOperation(
        set,
        get,
        pluginService,
        `plugin:reset-config:${pluginId}`,
        async (workspace) => {
          await pluginService.resetPluginConfig({
            ...workspace,
            pluginId,
            scope,
          });
        },
        scope,
      );
    },

    async validateSource(source, pluginService) {
      const { workspacePath, workspaceIdentity } = get();
      if (!workspacePath) return;
      const finish = beginPluginOperation(set, get, `marketplace:validate:${source}`);
      const version = get().operationVersion;
      try {
        const result = await pluginService.validatePlugin({
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          source,
        });
        if (get().operationVersion === version) set({ diagnostics: result.diagnostics });
      } catch (error) {
        logger.error("[plugins] validate source failed", { source, error: toMessage(error) });
        if (get().operationVersion === version) {
          set({ error: toMessage(error), lastFailedPluginId: null });
        }
      } finally {
        finish();
      }
    },

    async setEnabled(pluginId, enabled, pluginService, scope = "user") {
      return setPluginEnabledOptimistically(set, get, pluginId, enabled, pluginService, scope);
    },

    async describePlugin(pluginId, pluginName, marketplace, pluginService, force = false) {
      const { workspacePath, workspaceIdentity, describeCache } = get();
      if (!workspacePath) return;
      const cached = describeCache[pluginId];
      // 已加载或正在加载时命中缓存，不重复请求；force 时强制重试。
      if (!force && cached && cached.status !== "error") return;
      const request: PluginDescribeEntry = { status: "loading" };
      set({ describeCache: { ...get().describeCache, [pluginId]: request } });
      try {
        const data = await pluginService.describePlugin({
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          marketplace,
          pluginName,
        });
        // 旧项目或已被重试替代的 describe 响应不能回填当前详情缓存。
        if (get().describeCache[pluginId] !== request) return;
        const blockingDiagnostic = data.diagnostics?.find(
          (diagnostic) => diagnostic.severity === "error",
        );
        if (data.components.length === 0 && blockingDiagnostic) {
          // CLI 的 describe 对不可解析来源采用 diagnostics 回包而非 RPC reject。
          // 旧 UI 把该回包缓存为 loaded，详情只显示空白且永远没有重试入口；这里将无组件的
          // error diagnostic 映射成可恢复错误态，同时保留正常的部分成功回包。
          set({
            describeCache: {
              ...get().describeCache,
              [pluginId]: { status: "error", error: blockingDiagnostic.message },
            },
          });
          return;
        }
        set({
          describeCache: {
            ...get().describeCache,
            [pluginId]: { status: "loaded", data },
          },
        });
      } catch (error) {
        if (get().describeCache[pluginId] !== request) return;
        logger.error("[plugins] describe failed", {
          pluginId,
          marketplace,
          error: toMessage(error),
        });
        set({
          describeCache: {
            ...get().describeCache,
            [pluginId]: { status: "error", error: toMessage(error) },
          },
        });
      }
    },
  }));
};

export const usePluginManagementStore = createPluginManagementStore();

// 全局设置消费者与市场投影使用相同的失效通道，避免只更新其中一类视图。
function subscribeStore(store: ReturnType<typeof createPluginManagementStore>) {
  return subscribePluginManagementChanges((change) => {
    if (
      change.owner !== store.getState &&
      isPluginManagementChangeRelevant(store.getState(), change)
    ) {
      return store.getState().refresh(undefined, { background: true });
    }
  });
}
subscribeStore(usePluginManagementStore);

/** 每个市场/管理视图持有独立查询投影，写入仍由同一个 CLI 插件服务负责。 */
export function useScopedPluginManagementStore(pluginService: IPluginManagementService) {
  // 服务切换后不能复用旧主机的目录和在途写入状态。
  const store = useMemo(() => createPluginManagementStore(pluginService), [pluginService]);
  useEffect(() => subscribeStore(store), [store]);
  return store;
}
