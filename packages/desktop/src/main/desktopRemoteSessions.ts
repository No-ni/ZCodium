/* eslint-disable max-lines -- Main 的完整薄转发契约集中维护请求与端口关联。 */
import { randomUUID } from "node:crypto";
import { BrowserWindow, MessageChannelMain } from "electron";
import type { MessagePortMain, UtilityProcess as ElectronUtilityProcess } from "electron";
import {
  buildRemoteWorkspaceIdentity,
  buildServerRemoteWorkspaceIdentity,
  buildRemoteEnvironmentKey,
  HostMessageTypes,
  HostResponseTypes,
  hostResponseMessageSchema,
  InternalChannels,
  PlatformChannels,
  resolveWorkspaceKey,
  type RemoteTarget,
  type ProviderProvisioningTrigger,
  type ProviderProvisioningLaneStatus,
  type WindowHostRemoteWorkspaceDescriptor,
  type HostRemoteWorkspaceContextBindReadyResponse,
  type HostRemoteWorkspaceContextBindFailedResponse,
} from "@zcode/shared";
import type { RemoteAssetDirs } from "./desktopRuntimeEnv.js";
import {
  ProviderProvisioningEnvironmentCoordinator,
  ProviderProvisioningExecutionError,
} from "./providerProvisioningEnvironmentCoordinator.js";

interface RemoteWorkspaceSessionContext {
  workspacePath: string;
  workspaceIdentity?: string;
}

interface PendingConnect {
  requestId: string;
  webContentsId: number;
  child: ElectronUtilityProcess;
  win: BrowserWindow;
  remoteSessionId?: string;
  resolve: (sessionId: string) => void;
  reject: (error: Error) => void;
}

interface PendingWorkspaceBind {
  requestId: string;
  generation: number;
  workspacePath: string;
  workspaceIdentity: string;
  phase: "host" | "renderer";
  resolve(): void;
  reject(error: Error): void;
}

interface RemoteAttachmentRoute {
  webContentsId: number;
  child: ElectronUtilityProcess;
  pendingConnect?: PendingConnect;
  pendingBind?: PendingWorkspaceBind;
  mobileAttachmentIds?: Set<string>;
  // Main 只保留端口转发所需的 request/session 关联和脱敏 descriptor；连接/任务事实归 Host。
  descriptor: WindowHostRemoteWorkspaceDescriptor;
  rendererAttachmentId?: string;
  pendingRendererAttachment?: {
    attachmentId: string;
    previousAttachmentId?: string;
    reason: string;
    timeout: NodeJS.Timeout;
    resolve: () => void;
    reject: (error: Error) => void;
  };
  attachmentState: "preparing" | "attachable" | "closed";
  providerProvisioningDispose?: () => void;
}

interface PendingProviderProvisioningExecution {
  readonly child: ElectronUtilityProcess;
  readonly remoteSessionId: string;
  readonly environmentKey: string;
  readonly trigger: ProviderProvisioningTrigger;
  readonly startedAtMonotonicMs: number;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

function isSameRemoteTarget(left: RemoteTarget, right: RemoteTarget): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "ssh":
      return (
        right.kind === "ssh" &&
        left.host.trim().toLowerCase() === right.host.trim().toLowerCase() &&
        (left.port ?? 22) === (right.port ?? 22) &&
        left.username.trim() === right.username.trim() &&
        (left.privateKeyPath ?? "") === (right.privateKeyPath ?? "")
      );
    case "wsl":
      return (
        right.kind === "wsl" &&
        (left.distro?.trim() || "default") === (right.distro?.trim() || "default") &&
        (left.user?.trim() ?? "") === (right.user?.trim() ?? "")
      );
    case "docker":
      return right.kind === "docker" && left.container === right.container;
    case "server":
      // 旧远端桥不接直连 Server 的部署路径，不能仅凭 URL 复用其它 Source 的 attachment。
      return false;
  }
}

function closeMessagePort(port: MessagePortMain | undefined): void {
  if (!port) return;
  try {
    port.close();
  } catch {
    // MessagePort 关闭失败不影响 Host 内 attachment 的 close/dispose 幂等收口。
  }
}

export function createRemoteWorkspaceSessionManager(options: {
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  windowHostProcessMap: Map<number, ElectronUtilityProcess>;
  resolveRemoteAssetDirs: () => RemoteAssetDirs;
  resolveWslTarget?: (
    target: Extract<RemoteTarget, { kind: "wsl" }>,
  ) => Promise<Extract<RemoteTarget, { kind: "wsl" }>>;
  createMessageChannel?: () => { port1: MessagePortMain; port2: MessagePortMain };
  rendererAttachmentReadyTimeoutMs?: number;
  monotonicNowMs?: () => number;
  providerProvisioningCoordinator?: ProviderProvisioningEnvironmentCoordinator;
}) {
  const pendingByRequestKey = new Map<string, PendingConnect>();
  const routesBySessionId = new Map<string, RemoteAttachmentRoute>();
  const reconnectsByWorkspaceKey = new Map<string, Promise<string>>();
  const listenedHosts = new WeakSet<ElectronUtilityProcess>();
  const pendingProviderProvisioningExecutions = new Map<
    string,
    PendingProviderProvisioningExecution
  >();
  const providerProvisioningCoordinator =
    options.providerProvisioningCoordinator ?? new ProviderProvisioningEnvironmentCoordinator();
  let appShutdownStarted = false;
  const monotonicNowMs = options.monotonicNowMs ?? (() => performance.now());

  function requestKey(webContentsId: number, requestId: string): string {
    return `${webContentsId}\0${requestId}`;
  }

  function getWindowHost(win: BrowserWindow): ElectronUtilityProcess {
    const child = options.windowHostProcessMap.get(win.webContents.id);
    if (!child || child.pid == null) {
      throw new Error(`未找到窗口 Local Host，windowId=${win.webContents.id}`);
    }
    ensureHostListener(child, win.webContents.id);
    return child;
  }

  function isRouteCurrent(route: RemoteAttachmentRoute): boolean {
    return (
      !appShutdownStarted &&
      route.attachmentState !== "closed" &&
      routesBySessionId.get(route.descriptor.remoteSessionId) === route &&
      options.windowHostProcessMap.get(route.webContentsId) === route.child &&
      route.child.pid != null
    );
  }

  function rejectPendingConnect(pending: PendingConnect, error: Error): void {
    const key = requestKey(pending.webContentsId, pending.requestId);
    if (pendingByRequestKey.get(key) !== pending) return;
    pendingByRequestKey.delete(key);
    pending.reject(error);
  }

  function rejectRoutePreparation(route: RemoteAttachmentRoute, error: Error): void {
    const pending = route.pendingConnect;
    route.pendingConnect = undefined;
    if (pending) rejectPendingConnect(pending, error);
    const binding = route.pendingBind;
    route.pendingBind = undefined;
    binding?.reject(error);
  }

  function rejectRouteProvisioning(route: RemoteAttachmentRoute, error: Error): void {
    for (const [requestId, pending] of pendingProviderProvisioningExecutions) {
      if (
        pending.child !== route.child ||
        pending.remoteSessionId !== route.descriptor.remoteSessionId
      )
        continue;
      pendingProviderProvisioningExecutions.delete(requestId);
      pending.reject(error);
    }
  }

  function createMessageChannel() {
    return options.createMessageChannel?.() ?? new MessageChannelMain();
  }

  function emitConnectionLog(
    win: BrowserWindow,
    payload: {
      requestId?: string;
      sessionId?: string;
      level: "info" | "warn" | "error";
      message: string;
    },
  ): void {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents.send(PlatformChannels.RemoteConnectionLog, {
      label: `window-host-${win.webContents.id}`,
      requestId: payload.requestId,
      sessionId: payload.sessionId,
      level: payload.level,
      source: "window-host-controller",
      message: payload.message,
      // 改造曾把完整 ISO 时间直接交给连接日志 UI，长时间戳会挤压 flex 日志列并换行。
      // 这里恢复既有的紧凑时钟展示契约，Host 的 requestId 路由和原始日志内容保持不变。
      timestamp: new Date().toLocaleTimeString(undefined, {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
    });
  }

  function detachServicePort(
    child: ElectronUtilityProcess,
    attachmentId: string,
    reason: string,
  ): void {
    try {
      child.postMessage({
        type: HostMessageTypes.DetachServicePort,
        attachmentId,
      });
    } catch (error) {
      // 候选 port 的回收属于幂等清理，不能因 Host 已退出导致 ready promise 再次悬空。
      options.logger.warn("[window-host-remote] detach renderer attachment failed", {
        attachmentId,
        reason,
        error,
      });
    }
  }

  async function attachRendererPort(
    win: BrowserWindow,
    route: RemoteAttachmentRoute,
    reason: string,
  ): Promise<void> {
    if (win.isDestroyed() || win.webContents.isDestroyed()) {
      throw new Error("窗口已关闭，无法 attachment 远程 workspace");
    }
    if (!isRouteCurrent(route)) {
      throw new Error("远程 workspace attachment 代际已失效");
    }
    const child = getWindowHost(win);
    const descriptor = route.descriptor;
    if (!descriptor.workspacePath || !descriptor.workspaceIdentity) {
      throw new Error(
        `远程 descriptor 缺少 workspace scope，sessionId=${descriptor.remoteSessionId}`,
      );
    }
    const { port1, port2 } = createMessageChannel();
    const attachmentId = randomUUID();
    const previousAttachmentId = route.rendererAttachmentId;
    const superseded = route.pendingRendererAttachment;
    if (superseded) {
      clearTimeout(superseded.timeout);
      route.pendingRendererAttachment = undefined;
      detachServicePort(child, superseded.attachmentId, "superseded");
      superseded.reject(
        new Error(`renderer attachment 已被后续换代替代，sessionId=${descriptor.remoteSessionId}`),
      );
    }

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = route.pendingRendererAttachment;
        if (!pending || pending.attachmentId !== attachmentId) return;
        route.pendingRendererAttachment = undefined;
        detachServicePort(child, attachmentId, "ready-timeout");
        const error = new Error(
          `renderer attachment ready 超时，sessionId=${descriptor.remoteSessionId}`,
        );
        options.logger.warn("[window-host-remote] renderer attachment ready timeout", {
          sessionId: descriptor.remoteSessionId,
          attachmentId,
          reason,
        });
        reject(error);
      }, options.rendererAttachmentReadyTimeoutMs ?? 15_000);
      timeout.unref?.();
      route.pendingRendererAttachment = {
        attachmentId,
        previousAttachmentId,
        reason,
        timeout,
        resolve,
        reject,
      };

      try {
        child.postMessage(
          {
            type: HostMessageTypes.AttachServicePort,
            requestId: randomUUID(),
            attachmentId,
            clientMode: "desktop-continuous",
            scope: {
              kind: "remote",
              remoteSessionId: descriptor.remoteSessionId,
              workspacePath: descriptor.workspacePath,
              workspaceIdentity: descriptor.workspaceIdentity,
            },
          },
          [port2],
        );
        win.webContents.postMessage(
          InternalChannels.ScopedServicePort,
          {
            attachmentId,
            sessionId: descriptor.remoteSessionId,
            target: descriptor.target,
            sourceServerId: descriptor.sourceServerId,
          },
          [port1],
        );
      } catch (error) {
        clearTimeout(timeout);
        route.pendingRendererAttachment = undefined;
        detachServicePort(child, attachmentId, "delivery-failed");
        closeMessagePort(port1);
        closeMessagePort(port2);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  function confirmRendererAttachmentReady(
    webContentsId: number,
    payload: { sessionId: string; attachmentId: string },
  ): void {
    const route = routesBySessionId.get(payload.sessionId);
    const pending = route?.pendingRendererAttachment;
    if (
      !route ||
      !isRouteCurrent(route) ||
      route.webContentsId !== webContentsId ||
      !pending ||
      pending.attachmentId !== payload.attachmentId
    ) {
      options.logger.warn("[window-host-remote] ignore stale renderer attachment ready", {
        webContentsId,
        sessionId: payload.sessionId,
        attachmentId: payload.attachmentId,
      });
      return;
    }

    clearTimeout(pending.timeout);
    route.pendingRendererAttachment = undefined;
    const child = options.windowHostProcessMap.get(route.webContentsId);
    if (!child || child.pid == null) {
      pending.reject(new Error(`窗口 Local Host 已退出，sessionId=${payload.sessionId}`));
      return;
    }
    route.rendererAttachmentId = pending.attachmentId;
    if (pending.previousAttachmentId) {
      // Host generation bind 会 fail-closed 立即失效 A；Main 仍需等 renderer 注册 B
      // 后再提升 route 并做幂等清理。reload 复挂没有 generation 换代，也因此不会提前拆掉可用旧 port。
      detachServicePort(child, pending.previousAttachmentId, "candidate-promoted");
    }
    options.logger.info(
      `[window-host-remote] renderer attachment ready, sessionId=${payload.sessionId}, reason=${pending.reason}`,
    );
    pending.resolve();
  }

  function handleConnected(
    child: ElectronUtilityProcess,
    webContentsId: number,
    requestId: string,
    descriptor: WindowHostRemoteWorkspaceDescriptor,
  ): void {
    const key = requestKey(webContentsId, requestId);
    const pending = pendingByRequestKey.get(key);
    if (!pending || pending.child !== child || appShutdownStarted) {
      if (child.pid != null)
        child.postMessage({
          type: HostMessageTypes.DisposeRemoteWorkspaceSession,
          requestId: randomUUID(),
          remoteSessionId: descriptor.remoteSessionId,
        });
      return;
    }
    if (pending.remoteSessionId) return;
    pending.remoteSessionId = descriptor.remoteSessionId;
    const route: RemoteAttachmentRoute = {
      webContentsId,
      child,
      pendingConnect: pending,
      descriptor,
      // 首次配置和 renderer ready 都是发布屏障，手机不能从中间态绕过。
      attachmentState: "preparing",
    };
    routesBySessionId.set(descriptor.remoteSessionId, route);
    const environmentKey = descriptor.sourceServerId
      ? `source-server:${descriptor.sourceServerId}`
      : buildRemoteEnvironmentKey(descriptor.target);
    const registration =
      descriptor.sourceServerId && descriptor.configurationMode !== "mirror-personal"
        ? { initialSync: Promise.resolve(), dispose: () => undefined }
        : providerProvisioningCoordinator.register(
            environmentKey,
            descriptor.remoteSessionId,
            (trigger) =>
              executeProviderProvisioning(
                child,
                descriptor.remoteSessionId,
                environmentKey,
                trigger,
              ),
            descriptor.sourceServerId,
          );
    route.providerProvisioningDispose = registration.dispose;
    const assertPreparing = () => {
      if (
        !isRouteCurrent(route) ||
        pendingByRequestKey.get(key) !== pending ||
        route.pendingConnect !== pending
      ) {
        throw new Error("远程 workspace 连接准备已取消");
      }
    };
    void registration.initialSync
      .then(() => {
        assertPreparing();
        return attachRendererPort(pending.win, route, "connect");
      })
      .then(() => {
        assertPreparing();
        pendingByRequestKey.delete(key);
        route.pendingConnect = undefined;
        route.attachmentState = "attachable";
        emitConnectionLog(pending.win, {
          requestId,
          sessionId: descriptor.remoteSessionId,
          level: "info",
          message: `远程 ${descriptor.target.kind} workspace 已连接`,
        });
        pending.resolve(descriptor.remoteSessionId);
      })
      .catch((error: unknown) => {
        route.providerProvisioningDispose?.();
        const failure = error instanceof Error ? error : new Error("远程 workspace 准备失败");
        // 旧结果只清理自己的 route/pending，不能删除复用同 session ID 的新连接。
        if (routesBySessionId.get(descriptor.remoteSessionId) === route) {
          route.attachmentState = "closed";
          routesBySessionId.delete(descriptor.remoteSessionId);
          rejectRoutePreparation(route, failure);
          detachRouteAttachments(route, "prepare-failed", failure);
          if (options.windowHostProcessMap.get(webContentsId) === child && child.pid != null) {
            child.postMessage({
              type: HostMessageTypes.DisposeRemoteWorkspaceSession,
              requestId: randomUUID(),
              remoteSessionId: descriptor.remoteSessionId,
            });
          }
        } else rejectPendingConnect(pending, failure);
      });
  }

  function executeProviderProvisioning(
    child: ElectronUtilityProcess,
    remoteSessionId: string,
    environmentKey: string,
    trigger: ProviderProvisioningTrigger,
  ): Promise<void> {
    const route = routesBySessionId.get(remoteSessionId);
    if (!route || route.child !== child || !isRouteCurrent(route)) {
      return Promise.reject(new Error("Remote Environment registration 已失效"));
    }
    const requestId = randomUUID();
    return new Promise<void>((resolve, reject) => {
      pendingProviderProvisioningExecutions.set(requestId, {
        child,
        remoteSessionId,
        environmentKey,
        trigger,
        startedAtMonotonicMs: monotonicNowMs(),
        resolve,
        reject,
      });
      try {
        child.postMessage({
          type: HostMessageTypes.ProviderProvisioningExecute,
          requestId,
          environmentKey,
          remoteSessionId,
          trigger,
        });
      } catch (error) {
        pendingProviderProvisioningExecutions.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  function detachRouteAttachments(
    route: RemoteAttachmentRoute,
    reason: string,
    error: Error,
  ): void {
    const child = route.child;
    if (route.pendingRendererAttachment) {
      const pending = route.pendingRendererAttachment;
      clearTimeout(pending.timeout);
      route.pendingRendererAttachment = undefined;
      if (child) detachServicePort(child, pending.attachmentId, reason);
      pending.reject(error);
    }
    if (route.rendererAttachmentId) {
      if (child) detachServicePort(child, route.rendererAttachmentId, reason);
      route.rendererAttachmentId = undefined;
    }
    for (const attachmentId of route.mobileAttachmentIds ?? [])
      detachServicePort(child, attachmentId, reason);
    route.mobileAttachmentIds?.clear();
  }

  function failWorkspaceBind(route: RemoteAttachmentRoute, error: Error): void {
    route.attachmentState = "closed";
    route.providerProvisioningDispose?.();
    rejectRoutePreparation(route, error);
    rejectRouteProvisioning(route, error);
    detachRouteAttachments(route, "workspace-bind-failed", error);
    if (routesBySessionId.get(route.descriptor.remoteSessionId) === route) {
      routesBySessionId.delete(route.descriptor.remoteSessionId);
      if (
        options.windowHostProcessMap.get(route.webContentsId) === route.child &&
        route.child.pid != null
      ) {
        try {
          route.child.postMessage({
            type: HostMessageTypes.DisposeRemoteWorkspaceSession,
            requestId: randomUUID(),
            remoteSessionId: route.descriptor.remoteSessionId,
          });
        } catch {
          options.logger.warn("[window-host-remote] bind cleanup transport unavailable");
        }
      }
    }
  }

  function handleWorkspaceBindResponse(
    child: ElectronUtilityProcess,
    webContentsId: number,
    response:
      | HostRemoteWorkspaceContextBindReadyResponse
      | HostRemoteWorkspaceContextBindFailedResponse,
  ): void {
    const route = routesBySessionId.get(response.remoteSessionId);
    const pending = route?.pendingBind;
    if (
      !route ||
      !pending ||
      route.child !== child ||
      route.webContentsId !== webContentsId ||
      !isRouteCurrent(route) ||
      pending.requestId !== response.requestId ||
      pending.phase !== "host"
    )
      return;
    if (response.type === HostResponseTypes.RemoteWorkspaceContextBindFailed) {
      failWorkspaceBind(route, new Error(response.error));
      return;
    }
    if (
      response.workspacePath !== pending.workspacePath ||
      response.workspaceIdentity !== pending.workspaceIdentity ||
      response.generation !== pending.generation + 1
    )
      return;
    const win = BrowserWindow.getAllWindows().find(
      (candidate) => candidate.webContents.id === webContentsId,
    );
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
      failWorkspaceBind(route, new Error("远程 workspace 所属窗口已关闭"));
      return;
    }
    pending.phase = "renderer";
    // Host 权威 scope 准备成功后才采纳 generation；Renderer ACK 不能替代这道屏障。
    route.descriptor = {
      ...route.descriptor,
      workspacePath: response.workspacePath,
      workspaceIdentity: response.workspaceIdentity,
      generation: response.generation,
    };
    void attachRendererPort(win, route, "workspace-context-bound")
      .then(() => {
        if (!isRouteCurrent(route) || route.pendingBind !== pending)
          throw new Error("远程 workspace 重新绑定已退休");
        route.pendingBind = undefined;
        route.attachmentState = "attachable";
        pending.resolve();
      })
      .catch(() => {
        if (route.pendingBind === pending)
          failWorkspaceBind(route, new Error("远程 workspace 重新绑定端口准备失败"));
      });
  }

  function handleClosed(
    child: ElectronUtilityProcess,
    webContentsId: number,
    event: {
      remoteSessionId: string;
      reason: "connection-closed" | "disposed" | "connect-cancelled";
      exitCode?: number | null;
      signal?: string | null;
      error?: string;
    },
  ): void {
    const route = routesBySessionId.get(event.remoteSessionId);
    if (!route || route.webContentsId !== webContentsId || route.child !== child) return;
    const failure = new Error("远程 workspace 连接已关闭");
    route.attachmentState = "closed";
    route.providerProvisioningDispose?.();
    rejectRoutePreparation(route, failure);
    rejectRouteProvisioning(route, failure);
    if (event.reason !== "connection-closed") {
      routesBySessionId.delete(event.remoteSessionId);
      detachRouteAttachments(route, "session-released", failure);
      return;
    }
    // 连接断开只把 route 标成 closed，已暴露的 desktop attachment 仍留在窗口 Host；
    // sessionId 换代后 Main 又会删除 route，导致旧 ChannelServer 永久失去回收入口。
    detachRouteAttachments(
      route,
      "session-connection-closed",
      new Error(`远程 workspace 已关闭，sessionId=${event.remoteSessionId}`),
    );
    const win = BrowserWindow.getAllWindows().find(
      (candidate) => candidate.webContents.id === webContentsId,
    );
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(PlatformChannels.RemoteSessionClosed, {
        sessionId: event.remoteSessionId,
        reason: "host-exit" as const,
        exitCode: event.exitCode ?? null,
        signal: event.signal ?? null,
      });
      emitConnectionLog(win, {
        sessionId: event.remoteSessionId,
        level: "warn",
        message: event.error || "远程 workspace 连接已断开",
      });
    }
  }

  function ensureHostListener(child: ElectronUtilityProcess, webContentsId: number): void {
    if (listenedHosts.has(child)) return;
    listenedHosts.add(child);
    child.on("message", (message: unknown) => {
      const parsed = hostResponseMessageSchema.safeParse(message);
      if (!parsed.success) return;
      if (parsed.data.type === HostResponseTypes.RemoteWorkspaceConnectionLog) {
        const pending = pendingByRequestKey.get(requestKey(webContentsId, parsed.data.requestId));
        if (!pending || pending.child !== child) return;
        // 多个远程连接共享 window Host，不能再从进程 label/stdout 猜日志归属；
        // Host 已带上连接 requestId，Main 只向对应发起窗口做薄转发。
        emitConnectionLog(pending.win, {
          requestId: parsed.data.requestId,
          level: parsed.data.level,
          message: parsed.data.message,
        });
        return;
      }
      if (parsed.data.type === HostResponseTypes.ProviderProvisioningSourceChanged) {
        if (options.windowHostProcessMap.get(webContentsId) !== child || appShutdownStarted) return;
        void providerProvisioningCoordinator.requestAll(parsed.data.trigger).catch(() => {
          options.logger.warn("[provider-provisioning] Environment sync failed");
        });
        return;
      }
      if (parsed.data.type === HostResponseTypes.ProviderProvisioningLaneRequest) {
        if (options.windowHostProcessMap.get(webContentsId) !== child || appShutdownStarted) return;
        const request = parsed.data;
        const result =
          request.action === "retry"
            ? providerProvisioningCoordinator.retry(request.sourceServerId)
            : providerProvisioningCoordinator.getLaneStatus(request.sourceServerId, {
                waitForIdle: request.action === "wait",
              });
        const reply = (status: ProviderProvisioningLaneStatus) => {
          // Main 协调器是唯一 lane owner；等待期间 Host 换代不能把结果送给继任者。
          if (
            options.windowHostProcessMap.get(webContentsId) !== child ||
            appShutdownStarted ||
            child.pid == null
          )
            return;
          try {
            child.postMessage({
              type: HostMessageTypes.ProviderProvisioningLaneResult,
              requestId: request.requestId,
              status,
            });
          } catch {
            options.logger.warn("[provider-provisioning] status response transport unavailable");
          }
        };
        void result.then(reply).catch(async () => {
          options.logger.warn("[provider-provisioning] status request failed");
          reply(await providerProvisioningCoordinator.getLaneStatus(request.sourceServerId));
        });
        return;
      }
      if (parsed.data.type === HostResponseTypes.ProviderProvisioningExecutionResult) {
        const pending = pendingProviderProvisioningExecutions.get(parsed.data.requestId);
        if (
          !pending ||
          pending.child !== child ||
          pending.environmentKey !== parsed.data.environmentKey
        )
          return;
        pendingProviderProvisioningExecutions.delete(parsed.data.requestId);
        const route = routesBySessionId.get(pending.remoteSessionId);
        if (!route || route.child !== child || !isRouteCurrent(route)) {
          pending.reject(new Error("Remote Environment registration 已失效"));
          return;
        }
        const logContext = {
          trigger: pending.trigger,
          status: parsed.data.status,
          durationMs: Math.max(0, monotonicNowMs() - pending.startedAtMonotonicMs),
        };
        if (parsed.data.status !== "applied" && parsed.data.status !== "already-applied") {
          // 旧转发仅拒绝首次失败，重试失败却 resolve，导致 lane 错记成功；所有触发源统一拒绝。
          // 只保留固定阶段码和安全指标，不转抄远端自由文本或可能包含连接地址的 Environment key。
          options.logger.warn("[provider-provisioning] Environment sync did not apply", logContext);
          pending.reject(
            new ProviderProvisioningExecutionError(
              "Provider provisioning execution failed",
              parsed.data.errorCode ??
                (parsed.data.status === "unsupported"
                  ? "capability-unavailable"
                  : "target-apply-failed"),
            ),
          );
          return;
        }
        options.logger.info("[provider-provisioning] Environment sync completed", logContext);
        pending.resolve();
        return;
      }
      if (
        parsed.data.type === HostResponseTypes.RemoteWorkspaceContextBindReady ||
        parsed.data.type === HostResponseTypes.RemoteWorkspaceContextBindFailed
      ) {
        handleWorkspaceBindResponse(child, webContentsId, parsed.data);
        return;
      }
      if (parsed.data.type === HostResponseTypes.RemoteWorkspaceConnected) {
        handleConnected(child, webContentsId, parsed.data.requestId, parsed.data.descriptor);
        return;
      }
      if (parsed.data.type === HostResponseTypes.RemoteWorkspaceConnectFailed) {
        const key = requestKey(webContentsId, parsed.data.requestId);
        const pending = pendingByRequestKey.get(key);
        if (!pending || pending.child !== child) return;
        rejectPendingConnect(pending, new Error(parsed.data.error));
        emitConnectionLog(pending.win, {
          requestId: parsed.data.requestId,
          level: "error",
          message: parsed.data.error,
        });
        return;
      }
      if (parsed.data.type === HostResponseTypes.RemoteWorkspaceClosed) {
        handleClosed(child, webContentsId, parsed.data);
      }
    });
    child.once("exit", () => {
      const error = new Error("窗口 Local Host 已退出");
      for (const [requestId, pendingExecution] of pendingProviderProvisioningExecutions) {
        if (pendingExecution.child !== child) continue;
        pendingProviderProvisioningExecutions.delete(requestId);
        pendingExecution.reject(error);
      }
      // 退出的是具体 Host 对象，同窗口的新 Host 不能被旧 exit 清理。
      for (const pending of Array.from(pendingByRequestKey.values())) {
        if (pending.child === child) rejectPendingConnect(pending, error);
      }
      for (const [sessionId, route] of Array.from(routesBySessionId)) {
        if (route.child !== child) continue;
        route.attachmentState = "closed";
        route.providerProvisioningDispose?.();
        routesBySessionId.delete(sessionId);
        rejectRoutePreparation(route, error);
        detachRouteAttachments(route, "host-exit", error);
      }
    });
  }

  async function createRemoteWorkspaceSession(
    win: BrowserWindow,
    target: RemoteTarget,
    requestId?: string,
    context?: RemoteWorkspaceSessionContext,
  ): Promise<string> {
    if (appShutdownStarted) {
      throw new Error("应用正在退出，无法创建远程工作区连接");
    }
    const child = getWindowHost(win);
    const resolvedTarget =
      target.kind === "wsl" && options.resolveWslTarget
        ? await options.resolveWslTarget(target)
        : target;
    if (appShutdownStarted) {
      // WSL identity 解析跨 await，期间退出屏障可能已清空 Main 请求关联并开始回收 Host。
      // 恢复后必须重新验证生命周期，禁止在 shutdown barrier 之后注册迟到请求。
      throw new Error("应用正在退出，无法创建远程工作区连接");
    }
    if (win.isDestroyed() || win.webContents.isDestroyed()) {
      throw new Error("窗口已关闭，无法创建远程工作区连接");
    }
    const resolvedRequestId = requestId ?? randomUUID();
    const key = requestKey(win.webContents.id, resolvedRequestId);
    if (pendingByRequestKey.has(key)) {
      throw new Error(`远程连接 requestId 重复，requestId=${resolvedRequestId}`);
    }
    emitConnectionLog(win, {
      requestId: resolvedRequestId,
      level: "info",
      message: `正在通过窗口 Host 连接 ${resolvedTarget.kind} workspace`,
    });
    return new Promise<string>((resolve, reject) => {
      pendingByRequestKey.set(key, {
        requestId: resolvedRequestId,
        webContentsId: win.webContents.id,
        child,
        win,
        resolve,
        reject,
      });
      child.postMessage({
        type: HostMessageTypes.ConnectRemoteWorkspace,
        requestId: resolvedRequestId,
        target: resolvedTarget,
        remoteAssets: options.resolveRemoteAssetDirs(),
        ...(context?.workspacePath ? { workspacePath: context.workspacePath } : {}),
        ...(context?.workspaceIdentity ? { workspaceIdentity: context.workspaceIdentity } : {}),
      });
    });
  }

  async function bindRemoteWorkspaceSessionContext(
    sessionId: string,
    context: RemoteWorkspaceSessionContext,
    expectedWebContentsId?: number,
  ): Promise<void> {
    const route = routesBySessionId.get(sessionId);
    if (!route) {
      if (expectedWebContentsId != null) {
        throw new Error(`未找到远程 workspace session，sessionId=${sessionId}`);
      }
      return;
    }
    if (!isRouteCurrent(route) || route.attachmentState !== "attachable") {
      throw new Error("远程 workspace 尚未完成 attachment 准备");
    }
    if (expectedWebContentsId != null && route.webContentsId !== expectedWebContentsId) {
      throw new Error(`远程 workspace session 不属于当前窗口，sessionId=${sessionId}`);
    }
    const workspaceIdentity = route.descriptor.sourceServerId
      ? buildServerRemoteWorkspaceIdentity({
          serverId: route.descriptor.sourceServerId,
          workspacePath: context.workspacePath,
        })
      : context.workspaceIdentity?.trim() ||
        buildRemoteWorkspaceIdentity(context.workspacePath, route.descriptor.target);
    const registeredChild = options.windowHostProcessMap.get(route.webContentsId);
    const win = BrowserWindow.getAllWindows().find(
      (candidate) => candidate.webContents.id === route.webContentsId,
    );
    if (!registeredChild || !win) {
      throw new Error(`未找到远程 workspace 所属窗口 Host，sessionId=${sessionId}`);
    }
    const child = getWindowHost(win);
    if (child !== route.child || win.isDestroyed() || win.webContents.isDestroyed())
      throw new Error("远程 workspace 所属 Host 已退休");
    route.attachmentState = "preparing";
    detachRouteAttachments(route, "workspace-rebind", new Error("远程 workspace 正在重新绑定"));
    const requestId = randomUUID();
    return new Promise<void>((resolve, reject) => {
      route.pendingBind = {
        requestId,
        generation: route.descriptor.generation,
        workspacePath: context.workspacePath,
        workspaceIdentity,
        phase: "host",
        resolve,
        reject,
      };
      try {
        child.postMessage({
          type: HostMessageTypes.BindRemoteWorkspaceContext,
          requestId,
          remoteSessionId: sessionId,
          workspacePath: context.workspacePath,
          workspaceIdentity,
        });
      } catch {
        failWorkspaceBind(route, new Error("远程 workspace 重新绑定请求发送失败"));
      }
    });
  }

  function reattachRemoteWorkspaceSessionsForWindow(win: BrowserWindow, reason: string): void {
    for (const route of Array.from(routesBySessionId.values())) {
      if (route.webContentsId !== win.webContents.id) continue;
      if (route.child !== options.windowHostProcessMap.get(win.webContents.id)) {
        failWorkspaceBind(route, new Error("窗口 Local Host 已换代"));
        continue;
      }
      if (route.attachmentState === "attachable") {
        void attachRendererPort(win, route, reason).catch((error: unknown) => {
          options.logger.warn("[window-host-remote] renderer reattach failed", {
            sessionId: route.descriptor.remoteSessionId,
            reason,
            error,
          });
        });
      }
    }
  }

  function requestSourceSettingsAttachment(
    win: BrowserWindow,
    sourceServerId: string,
  ): { attachmentId: string } {
    if (appShutdownStarted || win.isDestroyed() || win.webContents.isDestroyed())
      throw new Error("Source settings attachment is unavailable");
    const child = getWindowHost(win);
    const attachmentId = randomUUID();
    const { port1, port2 } = createMessageChannel();
    try {
      // 是否在线及配置面权限由窗口 Host 判断；Main 只转发端口，不建立第二份连接状态。
      child.postMessage(
        {
          type: HostMessageTypes.AttachServicePort,
          requestId: randomUUID(),
          attachmentId,
          clientMode: "desktop-continuous",
          scope: { kind: "source-settings", sourceServerId },
        },
        [port2],
      );
      win.webContents.postMessage(
        InternalChannels.SourceSettingsServicePort,
        { attachmentId, sourceServerId },
        [port1],
      );
      return { attachmentId };
    } catch {
      detachServicePort(child, attachmentId, "source-settings-delivery-failed");
      closeMessagePort(port1);
      closeMessagePort(port2);
      throw new Error("Source settings attachment delivery failed");
    }
  }

  function disposeRemoteWorkspaceSession(sessionId: string, _reason?: string): void {
    const route = routesBySessionId.get(sessionId);
    if (!route) return;
    route.attachmentState = "closed";
    routesBySessionId.delete(sessionId);
    route.providerProvisioningDispose?.();
    const error = new Error("远程 workspace session 已释放");
    rejectRoutePreparation(route, error);
    rejectRouteProvisioning(route, error);
    detachRouteAttachments(route, "session-disposed", error);
    if (
      options.windowHostProcessMap.get(route.webContentsId) !== route.child ||
      route.child.pid == null
    )
      return;
    route.child.postMessage({
      type: HostMessageTypes.DisposeRemoteWorkspaceSession,
      requestId: randomUUID(),
      remoteSessionId: sessionId,
    });
  }

  function disposeRemoteWorkspaceSessionsForWindow(webContentsId: number): void {
    const error = new Error("窗口已关闭，远程连接已取消");
    for (const [sessionId, route] of Array.from(routesBySessionId)) {
      if (route.webContentsId !== webContentsId) continue;
      route.attachmentState = "closed";
      routesBySessionId.delete(sessionId);
      route.providerProvisioningDispose?.();
      rejectRoutePreparation(route, error);
      rejectRouteProvisioning(route, error);
      detachRouteAttachments(route, "window-closed", error);
    }
    for (const pending of Array.from(pendingByRequestKey.values())) {
      if (pending.webContentsId === webContentsId) rejectPendingConnect(pending, error);
    }
  }

  function cancelPendingRemoteWorkspaceSessionsForWindow(
    webContentsId: number,
    _reason: string,
    requestId?: string,
  ): void {
    const error = new Error("远程连接已取消");
    for (const route of Array.from(routesBySessionId.values())) {
      if (
        route.webContentsId === webContentsId &&
        route.pendingBind &&
        (!requestId || route.pendingBind.requestId === requestId)
      )
        failWorkspaceBind(route, error);
    }
    for (const pending of Array.from(pendingByRequestKey.values())) {
      if (pending.webContentsId !== webContentsId || (requestId && pending.requestId !== requestId))
        continue;
      const sessionId = pending.remoteSessionId;
      const route = sessionId ? routesBySessionId.get(sessionId) : undefined;
      // Host 已报告 connected 后，取消请求不再位于其 connect map；Main 先退休准备态再释放 logical session。
      rejectPendingConnect(pending, error);
      if (route?.pendingConnect === pending)
        disposeRemoteWorkspaceSession(route.descriptor.remoteSessionId);
      pending.child.postMessage({
        type: HostMessageTypes.CancelRemoteWorkspaceConnect,
        requestId: pending.requestId,
      });
    }
  }

  function attachRemoteWorkspaceSessionHost(params: {
    windowId: number;
    remoteSessionId: string;
    workspacePath: string;
    workspaceIdentity: string;
    workspaceKey: string;
    clientMode: "web-remote-replayable";
  }): {
    process: ElectronUtilityProcess;
    port: MessagePortMain;
    remoteKind: RemoteTarget["kind"];
  } {
    const route = routesBySessionId.get(params.remoteSessionId);
    if (!route) {
      throw Object.assign(
        new Error(`未找到远程 workspace session，sessionId=${params.remoteSessionId}`),
        {
          code: "REMOTE_SESSION_MISSING" as const,
        },
      );
    }
    if (!isRouteCurrent(route) || route.attachmentState !== "attachable") {
      throw Object.assign(new Error("远程 workspace source 当前未就绪"), {
        code: "REMOTE_SESSION_OFFLINE" as const,
      });
    }
    const win = BrowserWindow.fromId(params.windowId);
    if (!win || win.webContents.id !== route.webContentsId) {
      throw Object.assign(new Error("远程 workspace session 不属于当前窗口"), {
        code: "REMOTE_SESSION_WINDOW_MISMATCH" as const,
      });
    }
    const descriptor = route.descriptor;
    if (
      descriptor.workspacePath !== params.workspacePath ||
      descriptor.workspaceIdentity !== params.workspaceIdentity ||
      params.workspaceKey !== params.workspaceIdentity
    ) {
      throw Object.assign(new Error("远程 workspaceKey 与 logical session 不匹配。"), {
        code: "REMOTE_WORKSPACE_IDENTITY_MISMATCH" as const,
      });
    }
    const process = getWindowHost(win);
    const { port1, port2 } = createMessageChannel();
    const attachmentId = randomUUID();
    route.mobileAttachmentIds ??= new Set();
    route.mobileAttachmentIds.add(attachmentId);
    port1.once("close", () => route.mobileAttachmentIds?.delete(attachmentId));
    try {
      process.postMessage(
        {
          type: HostMessageTypes.AttachServicePort,
          requestId: randomUUID(),
          attachmentId,
          clientMode: params.clientMode,
          scope: {
            kind: "remote",
            remoteSessionId: params.remoteSessionId,
            workspacePath: params.workspacePath,
            workspaceIdentity: params.workspaceIdentity,
          },
        },
        [port2],
      );
    } catch {
      route.mobileAttachmentIds.delete(attachmentId);
      closeMessagePort(port1);
      closeMessagePort(port2);
      throw new Error("远程 workspace attachment 请求发送失败");
    }
    return { process, port: port1, remoteKind: descriptor.target.kind };
  }

  /**
   * 远端 workspace 连接态的唯一事实来源：remote session 路由表。
   * `attachmentState === "attachable"` 表示该 remoteSessionId 已挂到窗口 Host 且可 attach；
   * 传入 webContentsId 时还会校验路由属于该窗口。UI 同步载荷里的连接态不被采信。
   */
  function hasAttachableRemoteSession(params: {
    webContentsId?: number;
    remoteSessionId: string;
  }): boolean {
    const route = routesBySessionId.get(params.remoteSessionId);
    if (!route) return false;
    if (!isRouteCurrent(route) || route.attachmentState !== "attachable") return false;
    if (params.webContentsId !== undefined && route.webContentsId !== params.webContentsId) {
      return false;
    }
    return true;
  }

  function hasRemoteWorkspaceSessionForTarget(
    win: BrowserWindow,
    target: RemoteTarget,
    context?: RemoteWorkspaceSessionContext,
  ): boolean {
    const workspaceKey = context ? resolveWorkspaceKey(context) : undefined;
    return Array.from(routesBySessionId.values()).some(
      (route) =>
        route.webContentsId === win.webContents.id &&
        route.attachmentState === "attachable" &&
        isSameRemoteTarget(route.descriptor.target, target) &&
        (!workspaceKey ||
          resolveWorkspaceKey({
            workspacePath: route.descriptor.workspacePath ?? "",
            workspaceIdentity: route.descriptor.workspaceIdentity,
          }) === workspaceKey),
    );
  }

  function reconnectBotRemoteWorkspaceSession(
    win: BrowserWindow,
    params: {
      target: RemoteTarget;
      workspacePath: string;
      workspaceIdentity: string;
      requestId?: string;
    },
  ): Promise<string> {
    const existing = Array.from(routesBySessionId.entries()).find(([, route]) => {
      return (
        route.webContentsId === win.webContents.id &&
        route.attachmentState === "attachable" &&
        route.descriptor.workspacePath === params.workspacePath &&
        route.descriptor.workspaceIdentity === params.workspaceIdentity &&
        isSameRemoteTarget(route.descriptor.target, params.target)
      );
    });
    if (existing) return Promise.resolve(existing[0]);
    const key = `${win.webContents.id}\0${params.workspaceIdentity}`;
    const pending = reconnectsByWorkspaceKey.get(key);
    if (pending) return pending;
    const reconnect = createRemoteWorkspaceSession(win, params.target, params.requestId, params);
    reconnectsByWorkspaceKey.set(key, reconnect);
    const cleanup = () => {
      if (reconnectsByWorkspaceKey.get(key) === reconnect) reconnectsByWorkspaceKey.delete(key);
    };
    // finally 会派生一个同样 reject 的无人等待 Promise；两条完成路径都消费清理结果，原错误仍交给调用方。
    void reconnect.then(cleanup, cleanup);
    return reconnect;
  }

  async function createBotRemoteWorkspaceRuntimePort(
    win: BrowserWindow,
    params: { target: RemoteTarget; workspacePath: string; workspaceIdentity: string },
    _requestId?: string,
  ): Promise<MessagePortMain> {
    const routeEntry = Array.from(routesBySessionId.entries()).find(([, route]) => {
      return (
        route.webContentsId === win.webContents.id &&
        route.attachmentState === "attachable" &&
        route.descriptor.workspacePath === params.workspacePath &&
        route.descriptor.workspaceIdentity === params.workspaceIdentity &&
        isSameRemoteTarget(route.descriptor.target, params.target)
      );
    });
    if (!routeEntry) {
      throw new Error("未找到可供 Bot attachment 的远程 logical session");
    }
    return attachRemoteWorkspaceSessionHost({
      windowId: win.id,
      remoteSessionId: routeEntry[0],
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      workspaceKey: params.workspaceIdentity,
      clientMode: "web-remote-replayable",
    }).port;
  }

  return {
    createRemoteWorkspaceSession,
    attachRemoteWorkspaceSessionHost,
    reconnectBotRemoteWorkspaceSession,
    bindRemoteWorkspaceSessionContext,
    confirmRendererAttachmentReady,
    reattachRemoteWorkspaceSessionsForWindow,
    requestSourceSettingsAttachment,
    hasRemoteWorkspaceSessionForTarget,
    hasAttachableRemoteSession,
    createBotRemoteWorkspaceRuntimePort,
    disposeRemoteWorkspaceSession,
    disposeRemoteWorkspaceSessionsForWindow,
    disposeAllAndWaitForAppShutdown: async (_reason: string) => {
      appShutdownStarted = true;
      const error = new Error("应用正在退出，远程连接已取消");
      for (const pending of Array.from(pendingByRequestKey.values()))
        rejectPendingConnect(pending, error);
      for (const [sessionId, route] of Array.from(routesBySessionId)) {
        route.attachmentState = "closed";
        routesBySessionId.delete(sessionId);
        route.providerProvisioningDispose?.();
        rejectRoutePreparation(route, error);
        rejectRouteProvisioning(route, error);
        detachRouteAttachments(route, "app-shutdown", error);
      }
      for (const pending of pendingProviderProvisioningExecutions.values()) pending.reject(error);
      pendingProviderProvisioningExecutions.clear();
    },
    cancelPendingRemoteWorkspaceSessionsForWindow,
    handleWorkspaceRunningTaskCountChanged: () => {
      // Running-task 事实现在由窗口 Host registry/ControllerProjection 持有；Main 不再维护 WSL pool。
    },
  };
}
