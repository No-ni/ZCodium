import type { WebRemoteControlAppPayload, WebRemoteControlTransportState } from "@zcode/shared";
import {
  LanRemoteControlEndpoint,
  type LanEndpointDeviceHandle,
  type LanEndpointDeviceHandlers,
} from "./lanEndpoint.js";
import type { WebRemoteControlLogger } from "./logger.js";

/**
 * 设备传输抽象：桌面运行时不感知端点形态。
 * - lan：桌面自身端点（默认，同网可达）；
 * - custom：用户自备隧道 / 自托管 relay（P4，按同一接口实现 WS 客户端）。
 *
 * 传输层只负责鉴权、配对、心跳与转发（见 spec），不持有业务状态。
 */

export interface WebRemoteControlDeviceTransportEvents {
  onStateChange(state: WebRemoteControlTransportState): void;
  onPayload(payload: WebRemoteControlAppPayload): void;
  onRegisteredAuth(auth: { deviceSid: string; passHash: string }): void;
  onError(error: Error): void;
  onInvalidPersistedAuth(): Promise<void>;
}

export interface WebRemoteControlDeviceTransport {
  start(): Promise<void>;
  sendPayload(payload: WebRemoteControlAppPayload): boolean;
  dispose(): void;
}

export interface LanDeviceTransportOptions {
  logger: WebRemoteControlLogger;
  deviceMid: string;
  deviceName: string;
  appVersion: string;
  events: WebRemoteControlDeviceTransportEvents;
  /** 移动端 payload 的目的地（带 deviceSid 供 manager 路由到对应窗口）。 */
  handleMobilePayload(deviceSid: string, payload: WebRemoteControlAppPayload): void;
  maxPhysicalFrameBytes: number;
  port?: number;
  auth:
    | { mode: "register"; passHash: string }
    | { mode: "persisted"; deviceSid: string; passHash: string };
  /** manager 持有的共享端点；已启动时不会重复 bind。 */
  endpoint: LanRemoteControlEndpoint;
}

/** LAN 传输：把端点能力适配成 DeviceTransport；start 后即可生成 QR。 */
export function createLanDeviceTransport(
  options: LanDeviceTransportOptions,
): WebRemoteControlDeviceTransport & { baseUrls(): string[] } {
  const endpoint = options.endpoint;
  let device: LanEndpointDeviceHandle | undefined;
  let disposed = false;
  const handlers: LanEndpointDeviceHandlers = {
    onStateChange: (state) => {
      if (disposed) return;
      options.events.onStateChange(
        state === "error" ? "error" : (state as WebRemoteControlTransportState),
      );
    },
    onPayload: (payload) => {
      if (!disposed) options.events.onPayload(payload);
    },
    onRegisteredAuth: (auth) => {
      if (!disposed) options.events.onRegisteredAuth(auth);
    },
    onError: (error) => {
      if (!disposed) options.events.onError(error);
    },
    onMobileDisconnected: () => {
      if (disposed) return;
      // 端点把「手机断开」上报为 waiting_terminal；宽限期由运行时决定。
      options.events.onStateChange("waiting_terminal");
    },
  };
  return {
    baseUrls: () => endpoint.baseUrls,
    async start() {
      if (!endpoint.isRunning) {
        await endpoint.start();
      }
      const registration = endpoint.registerDevice(options.auth, handlers);
      if (registration.ok) {
        device = registration.handle;
        return;
      }
      // 持久化 sid 已失效（端点重启 / 停止后重开 / TTL 清扫 / 其他窗口占用同一 sid）：
      // 配对表只在端点内存里，跨进程重启必然查不到旧 sid。与 relay 传输对 AUTH_FAILED
      // 的处理一致，这里清档后转注册流程重新配对，让桌面首开直接拿到可用二维码；
      // 否则 start 会带着一个端点不认识的 sid 收尾，运行时被置成 error、快照不带 qrUrl，
      // UI 一直显示「正在准备二维码」，只能靠用户手动点「刷新二维码」恢复。
      options.logger.warn("[web-remote-control] persisted device auth invalid, re-registering", {
        transport: "lan",
        deviceSidSuffix:
          options.auth.mode === "persisted" ? options.auth.deviceSid.slice(-6) : undefined,
      });
      await options.events.onInvalidPersistedAuth();
      if (disposed) return;
      const reregistered = endpoint.registerDevice(
        { mode: "register", passHash: options.auth.passHash },
        handlers,
      );
      if (reregistered.ok) {
        device = reregistered.handle;
      }
    },
    sendPayload(payload) {
      if (disposed || !device) return false;
      return endpoint.deliverToMobile(device.deviceSid, payload);
    },
    dispose() {
      disposed = true;
      // handle 的 dispose 按注册时拿到的 sid 释放配对项；恢复路径注册的是新 sid，
      // 因此不能再按创建传输时记的旧 sid 释放一次（那条路径已由 handle 覆盖）。
      device?.dispose();
    },
  };
}
