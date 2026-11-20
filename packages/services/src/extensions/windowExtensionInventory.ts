import { Emitter } from "@zcode/rpc";
import { resolvePluginManifest } from "@zcode/shared/extension-host";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { readPluginManifest } from "#src/extensions/manifestReader.js";
import { createGrantsStore } from "#src/extensions/grantsStore.js";
import { createSessionsBackend } from "#src/extensions/sessionsBackend.js";
import type { ExtensionsContributionsMessage } from "#src/extensions/contract.js";
import { type WindowHostExtensionsDeps } from "./windowHostExtensionsTypes.js";
import type { WindowExtensionState } from "./windowHostExtensionsTypes.js";
interface Context {
  state: WindowExtensionState;
  deps: WindowHostExtensionsDeps;
  grants: ReturnType<typeof createGrantsStore>;
  sessions: ReturnType<typeof createSessionsBackend>;
  logger: ReturnType<typeof createServiceLogger>;
  contributions: Emitter<ExtensionsContributionsMessage>;
  grantFactsChanged: Emitter<void>;
  enqueueStatic(label: string, task: () => Promise<void>): Promise<void>;
}
export function createWindowExtensionInventory({
  state,
  deps,
  grants,
  sessions,
  logger,
  contributions,
  grantFactsChanged,
  enqueueStatic,
}: Context) {
  /**
   * 按最近一次读到的清单发布静态表与扩展声明。等待激活确认（pending）与选择不激活（declined）的插件
   * 不进扩展声明，静态表的这一项带 activation（§17.7，P3b）。
   */
  const publishStatic = (reason: string) => {
    state.table = {
      rev: state.table.rev + 1,
      plugins: state.resolvedPlugins.map(({ entry }) => {
        const activation = grants.activationHold(entry.pluginId);
        return activation ? { ...entry, activation } : entry;
      }),
    };
    state.declarations = {
      plugins: state.resolvedPlugins.flatMap(({ entry, declaration }) =>
        declaration && !grants.activationHold(entry.pluginId) ? [declaration] : [],
      ),
    };
    logger.info(
      undefined,
      `static table rev=${state.table.rev} plugins=${state.table.plugins.length} extensions=${state.declarations.plugins.length} held=${state.table.plugins.filter((plugin) => plugin.activation).length} items=${state.table.plugins.reduce((count, plugin) => count + plugin.slotItems.length, 0)} (${reason})`,
    );
    contributions.fire({ kind: "static", table: state.table });
    grantFactsChanged.fire();
  };

  /**
   * 从插件商店安装后、激活前的确认（§17.7，P3b）：安装的成功信号没有插件 id，所以按静态表判断。
   * 新出现、扩展合法且有 main 的插件，在已有别的插件持有生效会话权限时先不激活，记为 pending。
   */
  const holdNewlyInstalled = async (
    resolved: typeof state.resolvedPlugins,
    previousIds: ReadonlySet<string>,
  ) => {
    for (const { entry } of resolved) {
      const extension = entry.extension;
      if (previousIds.has(entry.pluginId) || extension?.state !== "ok" || !extension.main) continue;
      if (grants.activationHold(entry.pluginId)) continue;
      const holders = grants.holders(entry.pluginId);
      if (holders.length === 0) continue;
      try {
        await grants.holdActivation(entry.pluginId, entry.version);
        logger.info(
          undefined,
          `extension activation held plugin=${entry.pluginId} holders=${holders.length} (installed while other extensions hold session grants)`,
        );
      } catch (error) {
        logger.warn(undefined, `hold extension activation failed plugin=${entry.pluginId}`, {
          code: (error as { code?: unknown } | null)?.code,
        });
      }
    }
  };

  /** 读插件清单与每个插件的 plugin.json，整份替换静态表与扩展声明（§16.1）。 */
  const readStaticTable = async (reason: string, options: { installed?: boolean } = {}) => {
    // 授权记录读完再算静态表：之后推的扩展声明让扩展激活，激活时的会话调用要看到已有的授权。
    await grants.ready;
    const result = await deps.pluginManagement.listPlugins({
      workspacePath: deps.inventoryWorkspacePath,
      configScope: "user",
    });
    // 扩展只认用户级启用（§13）：工作区级启用不激活扩展代码；未物化的插件包没有可读的清单。
    const plugins = result.plugins.filter(
      (plugin) =>
        plugin.enabled &&
        plugin.enabledSource !== "workspace" &&
        plugin.packageStatus !== "missing",
    );
    const resolved = await Promise.all(
      plugins.map(async (plugin) =>
        resolvePluginManifest(
          {
            pluginId: plugin.id,
            name: plugin.name,
            ...(plugin.version ? { version: plugin.version } : {}),
            rootPath: plugin.rootPath,
            ...(plugin.dataPath ? { dataPath: plugin.dataPath } : {}),
          },
          await readPluginManifest(plugin.rootPath),
        ),
      ),
    );
    if (state.disposed) return;
    const previousIds = new Set(state.table.plugins.map((plugin) => plugin.pluginId));
    // 按新清单重算授权（插件更新：不变多不询问、变多待授权、变少收窄）；生效档位变少的插件中止在途调用。
    for (const pluginId of grants.reconcile({
      rev: state.table.rev,
      plugins: resolved.map(({ entry }) => entry),
    }))
      sessions.abortPlugin(pluginId);
    if (options.installed) await holdNewlyInstalled(resolved, previousIds);
    if (state.disposed) return;
    state.resolvedPlugins = resolved;
    // 清单问题按插件记一次（重读只在插件清单变化与重新加载时发生，频率低）。
    for (const { entry } of resolved) {
      const extension = entry.extension;
      if (extension && extension.state !== "ok") {
        logger.warn(
          undefined,
          `extension ${extension.state} ${entry.pluginId}: ${extension.reason}${extension.state === "invalid" ? ` (${extension.path})` : ""}`,
        );
      }
      for (const problem of entry.problems) {
        logger.warn(
          undefined,
          `manifest item unusable ${entry.pluginId} ${problem.path}: ${problem.reason}`,
        );
      }
      for (const ignored of entry.ignored) {
        logger.info(
          undefined,
          `manifest ignored ${entry.pluginId} ${ignored.path}: ${ignored.reason}`,
        );
      }
    }
    publishStatic(reason);
  };

  const pushDeclarations = async () => {
    const target = state.connection;
    const current = state.declarations;
    if (!target || !current) return;
    await target.host.setDeclarations(current);
    logger.info(
      undefined,
      `declarations pushed gen=${target.gen} extensions=${current.plugins.length}`,
    );
  };

  const refreshStatic = (reason: string, options: { installed?: boolean } = {}) =>
    enqueueStatic("refresh extension static table", async () => {
      await readStaticTable(reason, options);
      await pushDeclarations();
    });
  return { publishStatic, pushDeclarations, refreshStatic };
}
