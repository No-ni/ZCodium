import type { WebSocket } from "ws";
import type { WebRemoteControlAppPayload, WebRemoteControlPairStatus } from "@zcode/shared";
import type { WebRemoteControlLogger } from "./logger.js";

export type WebRemoteControlEndpointDeviceState =
  | "connecting"
  | "registering"
  | "authenticating"
  | "waiting_terminal"
  | "paired"
  | "error";

export interface LanEndpointDeviceHandlers {
  onStateChange(state: WebRemoteControlEndpointDeviceState): void;
  onPayload(payload: WebRemoteControlAppPayload): void;
  onRegisteredAuth(auth: { deviceSid: string; passHash: string }): void;
  onError(error: Error): void;
  onMobileDisconnected(): void;
}

/**
 * 设备注册结果。持久化 sid 失效时端点只报告、不置 error：配对表只在端点内存里，
 * 桌面重启或没有保留手机在线配对的「停止后重开」会查不到旧 sid，由调用方清档后重新配对
 * （与 relay 传输对 AUTH_FAILED 的处理一致）。若在此处置 error，运行时会被打成
 * error 态，快照不带 qrUrl，UI 一直停在「正在准备二维码」，只能靠用户手动刷新。
 */
export type LanEndpointDeviceRegistration =
  | { ok: true; handle: LanEndpointDeviceHandle }
  | { ok: false; reason: "invalid-persisted-auth" };

export interface LanEndpointDeviceHandle {
  readonly deviceSid: string;
  sendPayload(payload: WebRemoteControlAppPayload): boolean;
  dispose(): void;
}

export interface LanEndpointOptions {
  logger: WebRemoteControlLogger;
  deviceMid: string;
  deviceName: string;
  appVersion: string;
  /**
   * 移动端 payload 的目的地。带 deviceSid：端点可能同时服务多个窗口的配对，
   * manager 据此路由到对应运行时。
   */
  handleMobilePayload(deviceSid: string, payload: WebRemoteControlAppPayload): void;
  maxPhysicalFrameBytes: number;
  /** 0 = 随机端口；显式端口便于用户配防火墙。 */
  port?: number;
}

interface DeviceSide {
  handle: LanEndpointDeviceHandle;
  handlers: LanEndpointDeviceHandlers;
}

export interface PairEntry {
  deviceSid: string;
  passHash: string;
  device?: DeviceSide;
  mobile?: WebSocket;
  pairStatus: WebRemoteControlPairStatus;
  lastSeenAt: number;
}
