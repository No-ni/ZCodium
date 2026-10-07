import { randomUUID } from "node:crypto";
import { z } from "zod";
import { resolveWorkspaceKey, type AppSettings } from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type {
  TaskAutoArchiveMaintenance,
  TaskAutoArchiveMaintenanceOptions,
  TaskAutoArchiveScope,
} from "./contract.js";

const INTERVAL_MS = 30 * 60 * 1000;
const CHANGED_CHANNEL = "task-auto-archive:changed";
const SETTINGS_CHANNEL = "task-auto-archive:settings";
const settingKeys = new Set<keyof AppSettings>([
  "taskAutoArchiveEnabled",
  "taskAutoArchiveOlderThanDays",
  "recentProjects",
  "lastWorkspaceSession",
]);
const envelopeSchema = z.object({ dataSourceKey: z.string(), senderId: z.string() });
const changedSchema = envelopeSchema.extend({
  scope: z.object({ workspacePath: z.string().min(1), workspaceIdentity: z.string().optional() }),
});
const logger = createServiceLogger("task-auto-archive");

function collectScopes(settings: AppSettings, conversationPath: string): TaskAutoArchiveScope[] {
  const scopes = new Map<string, TaskAutoArchiveScope>();
  const add = (scope: TaskAutoArchiveScope) => {
    if (scope.workspacePath.trim()) scopes.set(resolveWorkspaceKey(scope), scope);
  };
  for (const workspacePath of settings.recentProjects) add({ workspacePath });
  for (const entry of settings.lastWorkspaceSession ?? []) {
    if (entry.kind === "local") add({ workspacePath: entry.workspacePath });
    // 历史远端缺少 identity 时宁可跳过，不能把相同路径当作本地工作区归档。
    else if (entry.workspaceIdentity?.trim())
      add({
        workspacePath: entry.workspacePath,
        workspaceIdentity: entry.workspaceIdentity.trim(),
      });
  }
  add({ workspacePath: conversationPath });
  return [...scopes.values()];
}

function schedule(scan: () => Promise<void>, intervalMs: number): () => void {
  const timer = setInterval(() => {
    void scan();
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

/** 保留策略由 Host 生命周期驱动；列表读取和 Renderer 缓存不再决定是否执行。 */
export function createTaskAutoArchiveMaintenance(
  options: TaskAutoArchiveMaintenanceOptions,
): TaskAutoArchiveMaintenance {
  const senderId = randomUUID();
  let started = false;
  let disposed = false;
  let generation = 0;
  let pending = false;
  let flight: Promise<void> | undefined;
  let stopTimer: (() => void) | undefined;
  let unsubscribeSettings: (() => void) | undefined;
  let unsubscribeBroadcast: (() => void) | undefined;

  async function broadcast(channel: string, scope?: TaskAutoArchiveScope): Promise<void> {
    try {
      await options.broadcastService?.send({
        channel,
        payload: { dataSourceKey: options.dataSourceKey, senderId, ...(scope ? { scope } : {}) },
      });
    } catch {
      // 归档已提交；广播失败不能回滚事实或阻止剩余工作区，重连会重新读取归属。
      logger.warn(undefined, "自动归档广播失败，列表将在重新读取时恢复");
    }
  }

  async function scan(): Promise<void> {
    const epoch = generation;
    const settings = await options.settingService.get();
    if (disposed || epoch !== generation || !settings.taskAutoArchiveEnabled) return;
    for (const scope of collectScopes(settings, options.conversationWorkspacePath())) {
      if (disposed || epoch !== generation) return;
      try {
        // 每个提交边界重读，防止另一窗口关闭开关后，旧批次仍把剩余工作区归档。
        const latest = await options.settingService.get();
        if (disposed || epoch !== generation || !latest.taskAutoArchiveEnabled) return;
        if (
          !collectScopes(latest, options.conversationWorkspacePath()).some(
            (current) => resolveWorkspaceKey(current) === resolveWorkspaceKey(scope),
          )
        )
          continue;
        if (
          (latest.taskAutoArchiveOlderThanDays ?? 7) !==
          (settings.taskAutoArchiveOlderThanDays ?? 7)
        ) {
          pending = true;
          return;
        }
        const target = scope.workspaceIdentity
          ? options.resolveRemoteTarget?.({ ...scope, workspaceIdentity: scope.workspaceIdentity })
          : undefined;
        if (
          scope.workspaceIdentity &&
          (!target ||
            !target.remoteSessionId ||
            target.workspaceIdentity !== scope.workspaceIdentity ||
            target.workspacePath !== scope.workspacePath)
        )
          continue;
        const params = {
          ...scope,
          olderThanDays: latest.taskAutoArchiveOlderThanDays ?? 7,
          ...(target ? { remoteSessionId: target.remoteSessionId } : {}),
        };
        const archived = target
          ? await target.archiveStaleTasks(params)
          : await options.taskService.archiveStaleTasks(params);
        if (archived.length > 0) {
          logger.info(undefined, "按设置自动归档旧任务", { count: archived.length });
          await broadcast(CHANGED_CHANNEL, scope);
        }
      } catch {
        logger.warn(undefined, "自动归档工作区失败，跳过并等待下一轮重试");
      }
    }
  }

  function requestScan(): Promise<void> {
    if (!started || disposed) return Promise.resolve();
    pending = true;
    if (!flight)
      flight = (async () => {
        try {
          while (pending && !disposed) {
            pending = false;
            try {
              await scan();
            } catch {
              logger.warn(undefined, "读取自动归档设置失败，跳过本轮扫描");
            }
          }
        } finally {
          flight = undefined;
        }
      })();
    return flight;
  }

  function settingsChanged(): void {
    generation++;
    void requestScan();
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    generation++;
    pending = false;
    stopTimer?.();
    unsubscribeSettings?.();
    unsubscribeBroadcast?.();
  }

  return {
    async start() {
      if (disposed || started) return;
      started = true;
      unsubscribeSettings = options.settingService.onDidUpdate(({ keys }) => {
        if (!keys.some((key) => settingKeys.has(key))) return;
        settingsChanged();
        void broadcast(SETTINGS_CHANNEL);
      });
      const subscription = options.broadcastService?.onMessage((message) => {
        if (message.channel !== CHANGED_CHANNEL && message.channel !== SETTINGS_CHANNEL) return;
        const parsed = (
          message.channel === CHANGED_CHANNEL ? changedSchema : envelopeSchema
        ).safeParse(message.payload);
        if (
          !parsed.success ||
          parsed.data.senderId === senderId ||
          parsed.data.dataSourceKey !== options.dataSourceKey
        )
          return;
        if (message.channel === SETTINGS_CHANNEL) settingsChanged();
        else if ("scope" in parsed.data)
          options.onExternalArchive(parsed.data.scope as TaskAutoArchiveScope);
      });
      unsubscribeBroadcast = () => subscription?.dispose();
      stopTimer = (options.schedule ?? schedule)(requestScan, INTERVAL_MS);
      await requestScan();
    },
    requestScan,
    dispose,
    async disposeAndWait() {
      dispose();
      await flight;
    },
  };
}
