import type {
  WebRemoteControlBridgeDescriptor,
  WebRemoteControlFailureReason,
  WebRemoteControlPlatformMethod,
  WebRemoteControlStatusSnapshot,
  WebRemoteControlTaskRef,
  WebRemoteControlWorkspaceRef,
} from "@zcode/shared";
import type { ICredentialService, ISettingService } from "@zcode/services";
import type { WebRemoteControlLogger } from "./logger.js";
import type { StartAuthorization } from "./authorization.js";

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
