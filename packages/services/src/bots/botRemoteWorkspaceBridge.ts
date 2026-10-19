import { randomUUID } from "node:crypto";
import { HostResponseTypes, type RemoteTarget } from "@zcode/shared";
import { type IZCodeTaskService as IZCodeTaskServiceShape } from "../session/zcodeTaskService.js";
import type { ICredentialService } from "../credential/credential.js";
import type { ISettingService } from "../setting/setting.js";
import { type ZCodeAgentAppRuntimePreferences } from "../zcode-agent/zcodeAgent.js";
import {
  createRemoteRuntimeServicesFromPort,
  type RemoteBotWorkspaceRuntimeServices,
} from "#src/bots/botRemoteRuntimeServices.js";
import {
  closeBotRuntimePort,
  subscribeBotRemoteWorkspaceResponses,
  type BotParentPort,
} from "./botRemoteWorkspaceMessages.js";

export function createBotRemoteWorkspaceService(params: {
  parentPort?: BotParentPort | null;
  settingService: ISettingService;
  credentialService: ICredentialService;
}) {
  if (!params.parentPort) {
    return undefined;
  }
  const activeParentPort = params.parentPort;
  const connectedWorkspaceKeys = new Set<string>();
  const pending = new Map<
    string,
    (result: { ok: boolean; sessionId?: string; error?: string }) => void
  >();
  const pendingRuntimePorts = new Map<
    string,
    (result: { ok: boolean; port?: unknown; error?: string }) => void
  >();
  const pendingConnectionStatus = new Map<
    string,
    (result: { ok: boolean; connected?: boolean; error?: string }) => void
  >();
  const runtimeServicesByWorkspaceKey = new Map<string, RemoteBotWorkspaceRuntimeServices>();
  const ownedRuntimeServices = new Set<RemoteBotWorkspaceRuntimeServices>();
  const receivedRuntimePorts = new Set<unknown>();
  const activeWaits = new Set<() => void>();
  let disposed = false;
  let latestAppRuntimePreferences: ZCodeAgentAppRuntimePreferences | undefined;
  let appRuntimePreferencesRevision = 0;
  const unsubscribe = subscribeBotRemoteWorkspaceResponses(activeParentPort, {
    pending,
    pendingConnectionStatus,
    pendingRuntimePorts,
    receivedRuntimePorts,
  });

  function closedError(): Error {
    return Object.assign(new Error("远端 workspace 桥接已关闭。"), {
      name: "BotRemoteWorkspaceClosedError",
      code: "BOT_REMOTE_WORKSPACE_CLOSED",
    });
  }

  function assertOpen(): void {
    if (disposed) throw closedError();
  }

  function waitWhileOpen<T>(
    start: () => Promise<T>,
    cleanup?: () => void,
    runtime?: RemoteBotWorkspaceRuntimeServices,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      assertOpen();
      let settled = false;
      let connectionListener: { dispose(): void } | undefined;
      const finish = (complete: () => void) => {
        if (settled) return;
        settled = true;
        activeWaits.delete(cancel);
        connectionListener?.dispose();
        cleanup?.();
        complete();
      };
      const cancel = () => finish(() => reject(closedError()));
      activeWaits.add(cancel);
      const connectionClosed = () =>
        finish(() =>
          reject(
            Object.assign(new Error("远端 runtime 连接已关闭。"), { name: "ConnectionClosed" }),
          ),
        );
      if (runtime?.closed) {
        connectionClosed();
        return;
      }
      connectionListener = runtime?.onDidClose(connectionClosed);
      try {
        // 配置/凭据/RPC 不一定可取消；关闭只终结本地等待，仍消费底层迟到的 rejection。
        void start().then(
          (value) => (disposed ? cancel() : finish(() => resolve(value))),
          (error: unknown) => finish(() => reject(error)),
        );
      } catch (error) {
        finish(() => reject(error));
      }
    });
  }

  function waitForResponse<T>(
    requests: Map<string, (result: T) => void>,
    message: { requestId: string; [key: string]: unknown },
    timeoutMs: number,
    timeoutResult: NoInfer<T>,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return waitWhileOpen(
      () =>
        new Promise<T>((resolve, reject) => {
          // Main 已回包时原计时器仍保留 resolver 到 5/60 秒期满；完成即取消自身 timer。
          requests.set(message.requestId, (result) => {
            if (timer !== undefined) clearTimeout(timer);
            resolve(result);
          });
          try {
            activeParentPort.postMessage(message);
          } catch (error) {
            requests.delete(message.requestId);
            reject(error);
            return;
          }
          // parentPort 可同步回包，不能在请求完成后重新挂上无用计时器。
          if (requests.has(message.requestId)) {
            timer = setTimeout(() => {
              if (requests.delete(message.requestId)) resolve(timeoutResult);
            }, timeoutMs);
          }
        }),
      () => {
        if (timer !== undefined) clearTimeout(timer);
        requests.delete(message.requestId);
      },
    );
  }

  async function buildRemoteTargetForWorkspace(target: {
    workspacePath: string;
    workspaceIdentity: string;
  }): Promise<RemoteTarget | null> {
    const settings = await waitWhileOpen(() => params.settingService.get());
    assertOpen();
    const workspaceIdentity = target.workspaceIdentity.trim();
    const remoteSessions = (settings.lastWorkspaceSession ?? []).filter(
      (item) => item.kind === "remote",
    );
    const entry =
      // Bugfix: UI 建连后可能把 workspacePath 规范化为 realpath，但 bot context 仍保留旧路径。
      // 远端身份隔离语义以 workspaceIdentity 为准，查连接信息时必须先按 identity 命中。
      remoteSessions.find((item) => item.workspaceIdentity === workspaceIdentity) ??
      remoteSessions.find(
        (item) =>
          item.workspacePath === target.workspacePath &&
          item.workspaceIdentity === workspaceIdentity,
      );
    if (!entry || entry.kind !== "remote") {
      return null;
    }
    if (entry.target.kind !== "ssh") {
      return entry.target;
    }
    const sshTarget = entry.target;
    return {
      kind: "ssh",
      host: entry.target.host,
      port: entry.target.port,
      username: entry.target.username,
      privateKeyPath: entry.target.privateKeyPath,
      password: entry.target.passwordCredentialKey
        ? ((await waitWhileOpen(() =>
            params.credentialService.load(sshTarget.passwordCredentialKey!),
          )) ?? undefined)
        : undefined,
      privateKeyPassphrase: entry.target.privateKeyPassphraseCredentialKey
        ? ((await waitWhileOpen(() =>
            params.credentialService.load(sshTarget.privateKeyPassphraseCredentialKey!),
          )) ?? undefined)
        : undefined,
    };
  }

  async function queryMainConnectionStatus(target: {
    workspacePath: string;
    workspaceIdentity: string;
    remoteTarget: RemoteTarget;
  }): Promise<boolean | null> {
    const requestId = `bot-status-${randomUUID()}`;
    const result = await waitForResponse(
      pendingConnectionStatus,
      {
        type: HostResponseTypes.BotRemoteWorkspaceConnectionStatusRequest,
        requestId,
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        target: target.remoteTarget,
      },
      5_000,
      { ok: false, error: "远端 workspace 连接状态查询超时。" },
    );
    return result.ok ? result.connected === true : null;
  }

  return {
    async isConnected(target: {
      workspacePath: string;
      workspaceIdentity: string;
    }): Promise<boolean> {
      const workspaceKey = target.workspaceIdentity.trim() || target.workspacePath;
      const remoteTarget = await buildRemoteTargetForWorkspace(target);
      assertOpen();
      if (!remoteTarget) {
        connectedWorkspaceKeys.delete(workspaceKey);
        return false;
      }

      // Bugfix: UI 手动重连不会经过 bot 的 /reconnect，单靠本地 Set 会误判为未连接。
      // 每次询问 main 的 live session 表，顺手清理远端断开后的陈旧 bot 标记。
      const connected = await queryMainConnectionStatus({
        ...target,
        remoteTarget,
      });
      assertOpen();
      if (connected !== null) {
        if (connected) {
          connectedWorkspaceKeys.add(workspaceKey);
        } else {
          connectedWorkspaceKeys.delete(workspaceKey);
        }
        return connected;
      }

      return connectedWorkspaceKeys.has(workspaceKey);
    },
    async ensureConnected(target: {
      workspacePath: string;
      workspaceIdentity: string;
    }): Promise<{ ok: boolean; message?: string }> {
      const remoteTarget = await buildRemoteTargetForWorkspace(target);
      assertOpen();
      if (!remoteTarget) {
        return {
          ok: false,
          message: "未找到该远端 workspace 的连接信息。",
        };
      }
      const requestId = `bot-reconnect-${randomUUID()}`;
      const result = await waitForResponse(
        pending,
        {
          type: HostResponseTypes.BotRemoteWorkspaceReconnectRequest,
          requestId,
          workspacePath: target.workspacePath,
          workspaceIdentity: target.workspaceIdentity,
          target: remoteTarget,
        },
        60_000,
        { ok: false, error: "远端 workspace 重连超时。" },
      );
      assertOpen();
      if (result.ok) {
        connectedWorkspaceKeys.add(target.workspaceIdentity.trim() || target.workspacePath);
        return { ok: true };
      }
      return { ok: false, message: result.error ?? "unknown" };
    },
    async getZCodeTaskService(target: {
      workspacePath: string;
      workspaceIdentity: string;
    }): Promise<IZCodeTaskServiceShape | null> {
      const services = await getRuntimeServices(target);
      assertOpen();
      return services?.zcodeTaskService ?? null;
    },
    async getModelSelectionService(target: { workspacePath: string; workspaceIdentity: string }) {
      const services = await getRuntimeServices(target);
      assertOpen();
      return services?.modelSelectionService ?? null;
    },
    async syncAppRuntimePreferences(preferences: ZCodeAgentAppRuntimePreferences): Promise<void> {
      assertOpen();
      latestAppRuntimePreferences = preferences;
      appRuntimePreferencesRevision += 1;
      // 修复原因：远端 Bot runtime 不属于任何 renderer 窗口，Root 的 Agent 同步无法触达它。
      // 这里只更新已经缓存的 runtime，避免切换设置时为了闲置 Bot 新建远端 Host/Agent。
      await Promise.all(
        Array.from(runtimeServicesByWorkspaceKey.values()).map((services) =>
          waitWhileOpen(
            () => services.zcodeAgentService.syncAppRuntimePreferences(preferences),
            undefined,
            services,
          ),
        ),
      );
      assertOpen();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      // 原 clear 让超时也找不到 resolver，Promise 永久悬挂；先终结等待并同步清理计时器。
      for (const cancel of activeWaits) cancel();
      // 注销业务消费者；传输层固定分发器继续回收迟到端口，不持有此 Bridge。
      unsubscribe();
      runtimeServicesByWorkspaceKey.clear();
      connectedWorkspaceKeys.clear();
      latestAppRuntimePreferences = undefined;
      // Main 回包与 async continuation 之间也可能关闭；接收即托管，包装后才转交 adapter。
      for (const port of receivedRuntimePorts) closeReceivedPort(port);
      for (const services of ownedRuntimeServices) services.dispose();
      ownedRuntimeServices.clear();
    },
  };

  function closeReceivedPort(port: unknown): void {
    if (receivedRuntimePorts.delete(port)) closeBotRuntimePort(port);
  }

  async function getRuntimeServices(target: {
    workspacePath: string;
    workspaceIdentity: string;
  }): Promise<RemoteBotWorkspaceRuntimeServices | null> {
    assertOpen();
    const workspaceKey = target.workspaceIdentity.trim() || target.workspacePath;
    const cached = runtimeServicesByWorkspaceKey.get(workspaceKey);
    if (cached) {
      return cached;
    }
    const remoteTarget = await buildRemoteTargetForWorkspace(target);
    assertOpen();
    if (!remoteTarget) {
      return null;
    }
    const requestId = `bot-runtime-${randomUUID()}`;
    const result = await waitForResponse(
      pendingRuntimePorts,
      {
        type: HostResponseTypes.BotRemoteWorkspaceRuntimePortRequest,
        requestId,
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        target: remoteTarget,
      },
      60_000,
      { ok: false, error: "远端 workspace runtime 初始化超时。" },
    );
    assertOpen();
    if (!result.ok || !result.port) {
      closeReceivedPort(result.port);
      throw new Error(result.error ?? "远端 workspace runtime 初始化失败。");
    }
    // Bugfix: Bot 任务以前只知道远端 identity，却继续调用本地 task service。
    // 这里把 main 转发来的远端 RPC 端口包装成一组 runtime services；
    // task wrapper 命令走 IZCodeTaskService，session 主状态走 ZCode session facade。
    let services: RemoteBotWorkspaceRuntimeServices;
    try {
      services = createRemoteRuntimeServicesFromPort(result.port);
    } catch (error) {
      closeReceivedPort(result.port);
      throw error;
    }
    receivedRuntimePorts.delete(result.port);
    ownedRuntimeServices.add(services);
    services.onDidClose(() => {
      ownedRuntimeServices.delete(services);
      // 并发初始化可能已缓存另一实例；旧连接关闭只失效自身，不能删除后来就绪的连接。
      if (runtimeServicesByWorkspaceKey.get(workspaceKey) === services) {
        runtimeServicesByWorkspaceKey.delete(workspaceKey);
        connectedWorkspaceKeys.delete(workspaceKey);
      }
    });
    try {
      // 远端 Bot 与 UI workspace 共用同一个远端 Environment。这里只确认远端
      // Model Selection Facade 已就绪，Desktop 不再向远端注入完整 Provider Registry。
      await waitWhileOpen(() => services.modelSelectionService.getView(), undefined, services);
      while (true) {
        const revision = appRuntimePreferencesRevision;
        const cachedPreferences = latestAppRuntimePreferences;
        const preferences: ZCodeAgentAppRuntimePreferences = cachedPreferences
          ? cachedPreferences
          : await waitWhileOpen(() => params.settingService.get(), undefined, services).then(
              (settings) => ({
                askUserQuestionAutoResolutionEnabled:
                  settings.askUserQuestionAutoResolutionEnabled !== false,
              }),
            );
        await waitWhileOpen(
          () => services.zcodeAgentService.syncAppRuntimePreferences(preferences),
          undefined,
          services,
        );
        assertOpen();
        if (revision === appRuntimePreferencesRevision) {
          break;
        }
      }
      // 只有远端 Registry 和 App Runtime Preferences 都已就绪后才缓存 runtime services。
      if (services.closed)
        throw Object.assign(new Error("远端 runtime 连接已关闭。"), { name: "ConnectionClosed" });
      runtimeServicesByWorkspaceKey.set(workspaceKey, services);
      return services;
    } catch (error) {
      if (ownedRuntimeServices.delete(services)) services.dispose();
      throw error;
    }
  }
}
