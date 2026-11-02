import type { DataSyncImportResultItem, RemoteTarget } from "@zcode/shared";
import { logger } from "@/logger.js";

/** 一个插件在目标端导入结束后的终态；pluginId / marketplace 属于同步流程字段，不进日志。 */
export interface PluginSyncOutcome {
  pluginId: string;
  marketplace: string;
  result: DataSyncImportResultItem;
  durationMs: number;
}

/** 推送中由弹窗注入：某项进入 / 离开可「停止」的阶段（远端 add / install），以及逐插件结果上报。 */
export interface DataSyncPushControl {
  setStoppable(key: string, stop: (() => void) | null): void;
  reportPluginSyncResult?(outcome: PluginSyncOutcome): void;
}

/** 按行停止后该项的错误标记，弹窗显示为「已停止」。 */
export const DATA_SYNC_STOPPED_ERROR = "stopped";

function toPluginSyncLogResult(item: DataSyncImportResultItem): string {
  if (item.status === "created" || item.status === "updated") return "success";
  if (item.status === "skipped") return "noop";
  if (item.error === DATA_SYNC_STOPPED_ERROR) return "cancelled";
  return "failure";
}

/**
 * 逐插件 sync 终态记录。
 * 修复原因：上游把它做成官方 UI 埋点（reportAppTelemetryEvent → 官方接收端），本 fork 不引入对外上报；
 * 保留同名工厂，退休只为官方上报而存在的平台参数；终态走安全本地日志。
 * 日志字段限定 scope、remoteKind、固定结果枚举与数值耗时，不带原文、路径、错误或 URL。
 * 旧插件同步弹窗删除后，逐插件「同步最终结果」的观测一起被删除，这里维持可排查性而不新增第二份事实。
 */
export function createPluginSyncResultReporter(
  remoteKind: RemoteTarget["kind"] | undefined,
): (outcome: PluginSyncOutcome) => void {
  return ({ result, durationMs }) => {
    logger.debug("[data-sync] plugin sync outcome", {
      scope: USER_SCOPE,
      remoteKind,
      result: toPluginSyncLogResult(result),
      durationMs: Math.max(0, Math.round(durationMs)),
    });
  };
}

export const USER_SCOPE = "user" as const;
