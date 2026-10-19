import {
  webRemoteControlStartRequestSchema,
  WEB_REMOTE_CONTROL_RPC_LIMITS,
  type WebRemoteControlAppPayload,
  type WebRemoteControlFailureReason,
  type WebRemoteControlBridgeDescriptor,
  type WebRemoteControlPlatformMethod,
  type WebRemoteControlStatusSnapshot,
  type WebRemoteControlTaskRef,
  type WebRemoteControlWorkspaceRef,
} from "@zcode/shared";
import type { ICredentialService, ISettingService } from "@zcode/services";
import type { WebRemoteControlLogger } from "./logger.js";
import { createNodeWebRemoteControlRelayAuthProvider } from "./authProvider.js";
import { createWebRemoteControlRelayAuthStorageProvider } from "./authStorage.js";
import { buildWindowQrUrl } from "./qrUrl.js";
import { deriveRelayHttpBase, isRelayWsUrl } from "./relayEndpointUrl.js";
import { LanRemoteControlEndpoint } from "./lanEndpoint.js";
import { createLanDeviceTransport } from "./deviceTransport.js";
import {
  createRelayDeviceTransport,
  type WebRemoteControlDeviceTransport,
  type WebRemoteControlDeviceTransportEvents,
} from "./relayTransport.js";
import { buildStatusSnapshot, type WebRemoteControlRuntime } from "./runtime.js";
import { pushWorkspaceListIfChanged, routeMobilePayload } from "./payloadRouter.js";
import { clearPendingOutbound, flushPendingOutbound, sendAppPayload } from "./outboundBuffer.js";
import { clearGraceTimer, mapTransportState } from "./transportState.js";
import { createStartAuthorizationStore, type StartAuthorization } from "./authorization.js";
import { closeChangedWorkspaceBridge, openWorkspaceBridge } from "./bridgeController.js";

/**
 * Web Remote Control 桌面运行时：按窗口一份，持有配对、传输与 Host bridge。
 *
 * 状态机（spec）：idle → starting → connecting → running ⇄ active → error；
 * 传输态 waiting_terminal = 等待手机，paired = 已配对。失败语义见 shared/status.ts。
 */

interface ElectronUtilityProcessLike {
  postMessage(message: unknown, transfer?: unknown[]): void;
}

export interface WebRemoteControlTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
}

export interface WebRemoteControlManagerDeps {
  logger: WebRemoteControlLogger;
  settingService: ISettingService;
  credentialService: ICredentialService;
  deviceMid: string;
  deviceName: string;
  appVersion: string;
  lanPort?: number;
  onStatusChanged(windowId: number, snapshot: WebRemoteControlStatusSnapshot): void;
  handlePlatformRequest(method: WebRemoteControlPlatformMethod, args: unknown): Promise<unknown>;
  /** 请 renderer 重连指定 workspace 的远端会话（workspace-reconnect-request）。 */
  reconnectWorkspace(windowId: number, workspaceKey: string): Promise<void>;
  resolveHostProcess(webContentsId: number): ElectronUtilityProcessLike | undefined;
  /**
   * 远端 workspace 连接态的权威解析：由桌面 remote session 路由表裁定。
   * UI 同步载荷里的 `kind` / `connectionState` 不是事实来源；未注入时保持原值不覆盖。
   */
  resolveRemoteWorkspaceConnectionState?: (remoteSessionId: string) => "connected" | "disconnected";
}

export type WebRemoteControlOpenBridgeResult =
  | { ok: true; bridge: WebRemoteControlBridgeDescriptor }
  | { ok: false; reason: WebRemoteControlFailureReason; error: string };

export interface WebRemoteControlManager {
  authorizeStart(windowId: number, target: WebRemoteControlTarget): StartAuthorization;
  startAuthorized(
    windowId: number,
    target: WebRemoteControlTarget,
    authorization: StartAuthorization,
  ): Promise<WebRemoteControlStatusSnapshot>;
  start(windowId: number, target: WebRemoteControlTarget): Promise<WebRemoteControlStatusSnapshot>;
  stop(windowId: number): Promise<void>;
  resetPairing(
    windowId: number,
    target: WebRemoteControlTarget,
  ): Promise<WebRemoteControlStatusSnapshot>;
  resetPairingAuthorized(
    windowId: number,
    target: WebRemoteControlTarget,
    authorization: StartAuthorization,
  ): Promise<WebRemoteControlStatusSnapshot>;
  getStatus(windowId: number): WebRemoteControlStatusSnapshot;
  syncWorkspaces(windowId: number, workspaces: WebRemoteControlWorkspaceRef[]): void;
  syncTasks(windowId: number, tasks: WebRemoteControlTaskRef[]): void;
  disposeWindow(windowId: number): Promise<void>;
}

export function createWebRemoteControlManager(
  deps: WebRemoteControlManagerDeps,
): WebRemoteControlManager {
  const runtimes = new Map<number, WebRemoteControlRuntime>();
  const runtimesByDeviceSid = new Map<string, WebRemoteControlRuntime>();
  // 在首次 await 前登记窗口操作身份；停止或后续启动使旧异步初始化失效，不能让它迟到复活。
  const lifecycleRequests = new Map<number, symbol>();
  const authorizationStore = createStartAuthorizationStore();
  const authProvider = createNodeWebRemoteControlRelayAuthProvider();
  const authStorage = createWebRemoteControlRelayAuthStorageProvider({
    settingService: deps.settingService,
    credentialService: deps.credentialService,
    logger: deps.logger,
  });
  const endpoint = new LanRemoteControlEndpoint({
    logger: deps.logger,
    deviceMid: deps.deviceMid,
    deviceName: deps.deviceName,
    appVersion: deps.appVersion,
    handleMobilePayload: (deviceSid, payload) => {
      const runtime = runtimesByDeviceSid.get(deviceSid);
      if (!runtime) return;
      void routeMobilePayload(payload, buildRouterContext(runtime));
    },
    maxPhysicalFrameBytes: WEB_REMOTE_CONTROL_RPC_LIMITS.maxPhysicalFrameBytes,
    port: deps.lanPort,
  });

  function workspaceKeyOf(target: { workspacePath: string; workspaceIdentity?: string }): string {
    return target.workspaceIdentity?.trim() || target.workspacePath;
  }

  function emitStatus(runtime: WebRemoteControlRuntime): void {
    if (runtimes.get(runtime.windowId) !== runtime) return;
    deps.onStatusChanged(runtime.windowId, buildStatusSnapshot(runtime));
  }

  function currentStatus(windowId: number): WebRemoteControlStatusSnapshot {
    const runtime = runtimes.get(windowId);
    return runtime ? buildStatusSnapshot(runtime) : { status: "idle" };
  }

  /** payloadRouter 上下文：统一出口，避免每个回调重复接线。 */
  function buildRouterContext(runtime: WebRemoteControlRuntime) {
    return {
      runtime,
      deps,
      authStorage,
      sendAppPayload: (target: WebRemoteControlRuntime, payload: WebRemoteControlAppPayload) =>
        sendAppPayload(target, payload, deps.logger),
      openBridge: (
        target: WebRemoteControlRuntime,
        request: Parameters<typeof openWorkspaceBridge>[1],
      ) =>
        openWorkspaceBridge(target, request, deps, (bridgeRuntime, envelope) =>
          sendAppPayload(bridgeRuntime, envelope, deps.logger),
        ),
      emitStatus,
    };
  }

  // ---- 生命周期 ----

  function disposeRuntime(runtime: WebRemoteControlRuntime, reason: string): void {
    const isCurrentRuntime = runtimes.get(runtime.windowId) === runtime;
    clearGraceTimer(runtime);
    clearPendingOutbound(runtime);
    runtime.bridge?.dispose();
    runtime.bridge = undefined;
    runtime.transport.dispose();
    if (isCurrentRuntime) runtimes.delete(runtime.windowId);
    if (runtimesByDeviceSid.get(runtime.deviceSid) === runtime) {
      runtimesByDeviceSid.delete(runtime.deviceSid);
    }
    deps.logger.info("[web-remote-control] stopped", {
      windowId: runtime.windowId,
      session: runtime.deviceSid,
      reason,
    });
    if (isCurrentRuntime) deps.onStatusChanged(runtime.windowId, { status: "idle" });
  }

  async function stopRuntime(windowId: number, reason: string): Promise<void> {
    const runtime = runtimes.get(windowId);
    if (!runtime) return;
    disposeRuntime(runtime, reason);
  }

  async function runLifecycleRequest(
    windowId: number,
    run: (operation: symbol) => Promise<WebRemoteControlStatusSnapshot>,
  ) {
    const operation = Symbol();
    lifecycleRequests.set(windowId, operation);
    try {
      return await run(operation);
    } catch (error) {
      // 配置读取或清档同样可能迟到失败；已失效操作不能把旧异常送回当前窗口覆盖新状态。
      if (lifecycleRequests.get(windowId) !== operation) return currentStatus(windowId);
      throw error;
    }
  }

  function start(windowId: number, target: WebRemoteControlTarget) {
    return runLifecycleRequest(windowId, (operation) => startRuntime(windowId, target, operation));
  }

  async function startRuntime(windowId: number, target: WebRemoteControlTarget, operation: symbol) {
    const isCurrent = () => lifecycleRequests.get(windowId) === operation;
    const parsed = webRemoteControlStartRequestSchema.parse(target);
    await stopRuntime(windowId, "restart");
    if (!isCurrent()) return currentStatus(windowId);
    const settings = await deps.settingService.get();
    if (!isCurrent()) return currentStatus(windowId);
    const endpointMode = settings.webRemoteControlEndpointMode ?? "lan";
    if (endpointMode === "custom") {
      // 跨网端点由用户自备（自己的隧道 / 自托管 relay）；未配置地址直接失败，
      // 不回退 LAN——避免把「跨网失败」伪装成「同网可用」。
      const customUrl = settings.webRemoteControlCustomEndpointUrl?.trim();
      if (!customUrl || !isRelayWsUrl(customUrl)) {
        throw new Error("尚未配置可用的远程端点地址（设置 → 远程控制 → 我的端点）");
      }
    }
    const persisted = await authStorage.load();
    if (!isCurrent()) return currentStatus(windowId);
    // relay 的 device SID 只允许一个活动 device socket；复用会互踢并把手机路由到最后绑定的窗口。
    // 凭据存储只有一个持久 SID，因此新窗口遇到其他 runtime 正在使用时必须重新注册。
    const persistedSidOwnedByAnotherWindow =
      persisted &&
      [...runtimes.values()].some(
        (activeRuntime) =>
          activeRuntime.windowId !== windowId && activeRuntime.deviceSid === persisted.deviceSid,
      );
    const auth:
      | { mode: "register"; passHash: string }
      | { mode: "persisted"; deviceSid: string; passHash: string } =
      persisted && !persistedSidOwnedByAnotherWindow
        ? { mode: "persisted", deviceSid: persisted.deviceSid, passHash: persisted.passHash }
        : {
            mode: "register",
            passHash: authProvider.createPassHash(authProvider.createPassword()),
          };

    const runtime: WebRemoteControlRuntime = {
      windowId,
      workspacePath: parsed.workspacePath,
      workspaceIdentity: parsed.workspaceIdentity,
      remoteSessionId: parsed.remoteSessionId,
      initialTaskId: parsed.initialTaskId,
      status: "starting",
      desktopAppVersion: deps.appVersion,
      deviceSid: auth.mode === "persisted" ? auth.deviceSid : "pending",
      passHash: auth.passHash,
      qrBaseUrl: "",
      qrUrl: "",
      transport: undefined as never,
      mobileConnected: false,
      hasEverPaired: false,
      mobileDeviceSeenAt: 0,
      pendingOutbound: [],
      workspaces: [],
      tasks: [],
    };
    const events: WebRemoteControlDeviceTransportEvents = {
      onStateChange: (state) =>
        mapTransportState(runtime, state, emitStatus, (pairedRuntime) =>
          flushPendingOutbound(pairedRuntime, deps.logger),
        ),
      onPayload: (payload) => void routeMobilePayload(payload, buildRouterContext(runtime)),
      onRegisteredAuth: (registered) => {
        // 运行中凭据失效会重新注册；路由索引和二维码必须随同一份注册更新，避免扫码仍指向旧 SID。
        if (runtimesByDeviceSid.get(runtime.deviceSid) === runtime) {
          runtimesByDeviceSid.delete(runtime.deviceSid);
        }
        runtime.deviceSid = registered.deviceSid;
        runtime.passHash = registered.passHash;
        runtimesByDeviceSid.set(registered.deviceSid, runtime);
        if (runtime.qrBaseUrl) runtime.qrUrl = buildWindowQrUrl(runtime, deps);
        // 后台持久化失败不能成为未处理拒绝；当前内存配对仍可用，日志不携带存储异常或 hash。
        void authStorage
          .save(registered)
          .catch(() =>
            deps.logger.warn("[web-remote-control] auth persistence failed", { windowId }),
          );
        deps.logger.info("[web-remote-control] device registered", {
          windowId,
          transport: endpointMode,
          deviceSidSuffix: registered.deviceSid.slice(-6),
        });
      },
      onError: (error) => {
        deps.logger.warn("[web-remote-control] device transport error", {
          windowId,
          transport: endpointMode,
          message: error.message,
        });
      },
      onInvalidPersistedAuth: () => authStorage.clear(),
    };
    let lanTransport: ReturnType<typeof createLanDeviceTransport> | null = null;
    const transport: WebRemoteControlDeviceTransport =
      endpointMode === "custom"
        ? createRelayDeviceTransport({
            logger: deps.logger,
            relayWsUrl: (settings.webRemoteControlCustomEndpointUrl ?? "").trim(),
            deviceMid: deps.deviceMid,
            deviceName: deps.deviceName,
            appVersion: deps.appVersion,
            maxPhysicalFrameBytes: WEB_REMOTE_CONTROL_RPC_LIMITS.maxPhysicalFrameBytes,
            auth,
            events,
          })
        : createLanDeviceTransport({
            logger: deps.logger,
            deviceMid: deps.deviceMid,
            deviceName: deps.deviceName,
            appVersion: deps.appVersion,
            auth,
            endpoint,
            events,
            handleMobilePayload: (deviceSid, payload) => {
              const target2 = runtimesByDeviceSid.get(deviceSid);
              if (!target2) return;
              void routeMobilePayload(payload, buildRouterContext(target2));
            },
            maxPhysicalFrameBytes: WEB_REMOTE_CONTROL_RPC_LIMITS.maxPhysicalFrameBytes,
            port: deps.lanPort,
          });
    if (endpointMode !== "custom") {
      lanTransport = transport as ReturnType<typeof createLanDeviceTransport>;
    }
    runtime.transport = transport;
    runtimes.set(windowId, runtime);
    // LAN 复用已有配对时没有新注册回调；必须在启动前恢复 SID 路由，否则手机 bootstrap 被静默丢弃。
    if (auth.mode === "persisted") runtimesByDeviceSid.set(auth.deviceSid, runtime);
    emitStatus(runtime);
    try {
      await transport.start();
    } catch (error) {
      // 旧握手失败只能清理自己的 runtime，不能按 windowId 停掉后续已经成功的启动。
      if (!isCurrent()) return currentStatus(windowId);
      await stopRuntime(windowId, "transport-start-failed");
      throw error;
    }
    if (!isCurrent()) return currentStatus(windowId);
    if (endpointMode === "custom") {
      // 用户的 relay 同时托管移动页与 WS；QR 指向它的 http(s) base。
      runtime.qrBaseUrl = deriveRelayHttpBase(
        (settings.webRemoteControlCustomEndpointUrl ?? "").trim(),
      );
    } else {
      const baseUrls = lanTransport?.baseUrls() ?? [];
      runtime.qrBaseUrl = baseUrls.find((url) => !url.includes("127.0.0.1")) ?? baseUrls[0] ?? "";
    }
    if (runtime.deviceSid && runtime.deviceSid !== "pending") {
      runtime.qrUrl = buildWindowQrUrl(runtime, deps);
    }
    emitStatus(runtime);
    try {
      await deps.settingService.update({
        webRemoteControlLastEnabledContext: {
          workspacePath: parsed.workspacePath,
          workspaceIdentity: parsed.workspaceIdentity,
          initialTaskId: parsed.initialTaskId,
        },
      });
    } catch (error) {
      if (!isCurrent()) return currentStatus(windowId);
      await stopRuntime(windowId, "startup-restore-persist-failed");
      throw error;
    }
    return currentStatus(windowId);
  }

  function resetPairing(windowId: number, target: WebRemoteControlTarget) {
    return runLifecycleRequest(windowId, async (operation) => {
      await authStorage.clear();
      if (lifecycleRequests.get(windowId) !== operation) return currentStatus(windowId);
      return startRuntime(windowId, target, operation);
    });
  }

  return {
    authorizeStart(windowId, target) {
      return authorizationStore.issue(windowId, target, workspaceKeyOf(target));
    },
    startAuthorized(windowId, target, authorization) {
      authorizationStore.consume(windowId, target, authorization, workspaceKeyOf(target));
      return start(windowId, target);
    },
    start,
    async stop(windowId) {
      lifecycleRequests.delete(windowId);
      await stopRuntime(windowId, "manual-stop");
      if (lifecycleRequests.has(windowId)) return;
      await deps.settingService
        .update({ webRemoteControlLastEnabledContext: undefined })
        .catch(() => undefined);
    },
    resetPairing,
    resetPairingAuthorized(windowId, target, authorization) {
      authorizationStore.consume(windowId, target, authorization, workspaceKeyOf(target));
      return resetPairing(windowId, target);
    },
    getStatus(windowId) {
      return currentStatus(windowId);
    },
    syncWorkspaces(windowId, workspaces) {
      const runtime = runtimes.get(windowId);
      if (!runtime) return;
      const previous = runtime.workspaces.find(
        (item) => item.workspaceKey === runtime.bridge?.workspaceKey,
      );
      runtime.workspaces = workspaces.map((workspace) => {
        // 带 remoteSessionId 的条目连接态归桌面裁定；UI 传来的值不作为事实。
        // deps 未注入时不覆盖，也不写假值（保持原始条目）。
        if (!workspace.remoteSessionId || !deps.resolveRemoteWorkspaceConnectionState) {
          return workspace;
        }
        return {
          ...workspace,
          connectionState: deps.resolveRemoteWorkspaceConnectionState(workspace.remoteSessionId),
        };
      });
      const closedBridgeId = closeChangedWorkspaceBridge(runtime, previous);
      pushWorkspaceListIfChanged(runtime, deps.logger);
      if (closedBridgeId)
        sendAppPayload(
          runtime,
          {
            zcode_type: "bridge-degraded",
            bridgeSessionId: closedBridgeId,
            reason: "workspace-scope-changed",
          },
          deps.logger,
        );
    },
    syncTasks(windowId, tasks) {
      const runtime = runtimes.get(windowId);
      if (!runtime) return;
      runtime.tasks = tasks;
      pushWorkspaceListIfChanged(runtime, deps.logger);
    },
    async disposeWindow(windowId) {
      lifecycleRequests.delete(windowId);
      await stopRuntime(windowId, "window-disposed");
    },
  };
}
