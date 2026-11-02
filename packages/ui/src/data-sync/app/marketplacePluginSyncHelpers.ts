import type { ZCodePluginsInstallResult } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import { logger } from "@/logger.js";
import {
  groupMirrorMarketplacePlugins,
  selectUserMarketplacePlugins,
  type UserMarketplacePlugin,
} from "@/data-sync/domain/marketplacePlugins.js";
import { USER_SCOPE } from "./pluginSyncResultReporter.js";

let operationCounter = 0;

export function createOperationId(key: string): string {
  operationCounter += 1;
  return `data-sync-plugin-${operationCounter}-${key.replace(/[^a-z0-9._-]+/giu, "-")}`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatInstallError(
  result: ZCodePluginsInstallResult,
  pluginId: string,
): string | null {
  const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity !== "warning");
  if (errors.length === 0) return null;
  return errors
    .map((diagnostic) => `${diagnostic.pluginId ?? pluginId}: ${diagnostic.message}`)
    .join("; ");
}

export function sameOptions(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
): boolean {
  const entries = Object.entries(left);
  return (
    entries.length === Object.keys(right).length &&
    entries.every(([key, value]) => right[key] === value)
  );
}

/**
 * 该端 User scope 的插件视图。数据同步从设置页打开时没有项目：两端都以该端 Host 的 home
 * （systemService.info）作为 workspacePath、不带 workspace identity，与设置页远端 User scope 的口径一致。
 */
export async function readUserPlugins(services: IServiceAccessor) {
  const { homedir } = await services.systemService.info();
  const view = { workspacePath: homedir, configScope: USER_SCOPE };
  const [overview, list] = await Promise.all([
    services.pluginManagementService.getPluginsOverview(view),
    services.pluginManagementService.listPlugins(view),
  ]);
  return {
    homeDir: homedir,
    overview,
    plugins: selectUserMarketplacePlugins(overview, list.plugins),
  };
}

/** 本地目录类来源的镜像预检：跨 marketplace 依赖的插件不能同步。预检失败时不阻塞列表，推送时由镜像导出报告。 */
export async function inspectMirrorBlocked(
  services: IServiceAccessor,
  plugins: readonly UserMarketplacePlugin[],
): Promise<Set<string>> {
  const blocked = new Set<string>();
  await Promise.all(
    [...groupMirrorMarketplacePlugins(plugins)].map(async ([marketplaceId, group]) => {
      try {
        const inspection = await services.pluginSyncService.inspectMarketplaceSourceMirror({
          marketplaceId,
          pluginNames: group.plugins.map((plugin) => plugin.installed.name),
          source: group.source,
        });
        for (const name of Object.keys(inspection.blocked)) blocked.add(`${name}@${marketplaceId}`);
      } catch (error) {
        logger.warn("[DataSync] marketplace 镜像预检失败", {
          marketplace: marketplaceId,
          error: errorMessage(error),
        });
      }
    }),
  );
  return blocked;
}
