import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { DATA_SYNC_STOPPED_ERROR } from "@/data-sync/app/marketplacePluginSync.js";
import {
  DATA_SYNC_OFFLINE_ERROR,
  DATA_SYNC_PREFLIGHT_TIMEOUT_ERROR,
  type DataSyncItemError,
} from "@/data-sync/app/useDataSyncDialog.js";
import type { DataSyncMissingDependencies } from "@/data-sync/domain/compare.js";

type FormatMessage = ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"];

export function formatPushError(formatMessage: FormatMessage, error: string): string {
  if (error === DATA_SYNC_OFFLINE_ERROR) {
    return formatMessage({ id: "remoteSync.error.offline" });
  }
  if (error === DATA_SYNC_PREFLIGHT_TIMEOUT_ERROR) {
    return formatMessage({ id: "remoteSync.error.preflightTimeout" });
  }
  return formatMessage({ id: "remoteSync.error.pushFailed" }, { error });
}

export function formatItemError(formatMessage: FormatMessage, error: DataSyncItemError): string {
  if (error.message === DATA_SYNC_STOPPED_ERROR) {
    return formatMessage({ id: "remoteSync.item.stopped" });
  }
  return error.status === "conflict"
    ? formatMessage({ id: "remoteSync.item.conflict" })
    : formatMessage(
        { id: "remoteSync.item.failed" },
        { error: error.message ?? formatMessage({ id: "remoteSync.item.unknownError" }) },
      );
}

/** 多个缺失项合并为一行：同类名称之间、MCP 与技能两组之间各用本地化分隔符。 */
export function formatMissingDependencies(
  formatMessage: FormatMessage,
  missing: DataSyncMissingDependencies,
): string {
  const nameSeparator = formatMessage({ id: "remoteSync.dependency.nameSeparator" });
  const groups: string[] = [];
  if (missing.mcpServers.length > 0) {
    groups.push(
      formatMessage(
        { id: "remoteSync.dependency.missingMcp" },
        { names: missing.mcpServers.join(nameSeparator) },
      ),
    );
  }
  if (missing.skills.length > 0) {
    groups.push(
      formatMessage(
        { id: "remoteSync.dependency.missingSkills" },
        { names: missing.skills.join(nameSeparator) },
      ),
    );
  }
  return groups.join(formatMessage({ id: "remoteSync.dependency.groupSeparator" }));
}
