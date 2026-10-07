import type { AppSettings } from "@zcode/shared";
import type { IBroadcastService } from "../broadcast/broadcast.js";
import type { ISettingService } from "../setting/setting.js";
import type { IZCodeTaskService } from "./zcodeTaskService.js";

export interface TaskAutoArchiveScope {
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface TaskAutoArchiveRemoteTarget extends TaskAutoArchiveScope {
  workspaceIdentity: string;
  remoteSessionId: string;
  archiveStaleTasks: IZCodeTaskService["archiveStaleTasks"];
}

/** Host 注入路由；实现必须在提交时复核当前 remoteSessionId 和完整 scope。 */
export type ResolveTaskAutoArchiveRemoteTarget = (
  scope: TaskAutoArchiveScope & { workspaceIdentity: string },
) => TaskAutoArchiveRemoteTarget | undefined;

export interface TaskAutoArchiveMaintenance {
  start(): Promise<void>;
  requestScan(): Promise<void>;
  dispose(): void;
  disposeAndWait(): Promise<void>;
}

export interface TaskAutoArchiveMaintenanceOptions {
  settingService: Pick<ISettingService, "get"> & {
    onDidUpdate(
      listener: (event: { readonly keys: readonly (keyof AppSettings)[] }) => void,
    ): () => void;
  };
  taskService: Pick<IZCodeTaskService, "archiveStaleTasks">;
  conversationWorkspacePath(): string;
  resolveRemoteTarget?: ResolveTaskAutoArchiveRemoteTarget;
  /** 同一 tasks-index 数据源的稳定标识；不包含原始路径。 */
  dataSourceKey: string;
  broadcastService?: Pick<IBroadcastService, "send" | "onMessage">;
  onExternalArchive(scope: TaskAutoArchiveScope): void;
  schedule?: (scan: () => Promise<void>, intervalMs: number) => () => void;
}
