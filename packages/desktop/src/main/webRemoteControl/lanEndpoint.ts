import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { randomBytes } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import type {
  WebRemoteControlAppPayload,
  WebRemoteControlEndpointToClientFrame,
} from "@zcode/shared";
import { attachLanMobileSocket } from "./lanMobileSocket.js";
import type {
  PairEntry,
  LanEndpointOptions,
  LanEndpointDeviceHandle,
  LanEndpointDeviceHandlers,
  LanEndpointDeviceRegistration,
} from "./lanEndpointTypes.js";
import { createMobileAppStaticHandler } from "./mobileAppAssets.js";
export type {
  WebRemoteControlEndpointDeviceState,
  LanEndpointOptions,
  LanEndpointDeviceHandle,
  LanEndpointDeviceHandlers,
  LanEndpointDeviceRegistration,
} from "./lanEndpointTypes.js";

/**
 * LAN 直连带端（默认传输）：桌面自身承担「设备注册 / 配对 / 转发」。
 *
 * - HTTP 同端口提供移动端静态页与 /healthz；WS 路径 `/ws` 走与官方兼容的 wire 帧；
 * - 绑定集合默认 = loopback + 本机 IPv4（LAN）；不绑 0.0.0.0，公网暴露由用户显式配置；
 * - 配对关系只在内存：端点重启即失效，业务状态不受影响（见 spec 状态所有者）。
 */

const WS_PATH = "/ws";
const PAIR_IDLE_TTL_MS = 24 * 60 * 60 * 1000;

interface LanEndpointInfo {
  port: number;
  /** 可达 base URL：loopback 在前（同机调试），LAN 地址是给手机的 QR 目标。 */
  baseUrls: string[];
}

export class LanRemoteControlEndpoint {
  private readonly servers = new Map<string, Server>();
  private readonly wss: WebSocketServer;
  private readonly pairs = new Map<string, PairEntry>();
  private readonly staticHandler: ReturnType<typeof createMobileAppStaticHandler>;
  private readonly maxFrameBytes: number;
  private info: LanEndpointInfo | null = null;
  private startPromise: Promise<LanEndpointInfo> | null = null;
  private stopPromise: Promise<void> | null = null;
  private pairSweepTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: LanEndpointOptions) {
    this.staticHandler = createMobileAppStaticHandler({ logger: options.logger });
    this.maxFrameBytes = options.maxPhysicalFrameBytes;
    // message 回调只在完整消息到齐后触发；接收器必须在分片累计超限时就拒绝继续分配。
    this.wss = new WebSocketServer({ noServer: true, maxPayload: this.maxFrameBytes });
  }

  get baseUrls(): string[] {
    return this.info?.baseUrls ?? [];
  }

  get isRunning(): boolean {
    return this.info !== null;
  }

  /** 释放设备侧会话（窗口停止/刷新配对时调用；仅摘除本端设备，不动配对表其他项）。 */
  releaseDevice(deviceSid: string): void {
    const entry = this.pairs.get(deviceSid);
    if (!entry) return;
    entry.device = undefined;
    // 设备释放后旧 Host bridge 已不可用；先通知手机禁发，复用 SID 时再通知 matched。
    entry.pairStatus = "waiting";
    if (entry.mobile?.readyState === WebSocket.OPEN) {
      entry.mobile.send(JSON.stringify({ type: "pair_status_ack", pair_status: "waiting" }));
    } else {
      this.pairs.delete(deviceSid);
    }
  }

  start(): Promise<LanEndpointInfo> {
    if (this.stopPromise) return this.stopPromise.then(() => this.start());
    if (this.info) return Promise.resolve(this.info);
    if (this.startPromise) return this.startPromise;

    // 多窗口共用同一端点；并发启动若各自 bind，会覆盖 servers 中的 listener 并遗留端口和计时器。
    const starting = this.startEndpoint();
    this.startPromise = starting;
    void starting
      .finally(() => {
        if (this.startPromise === starting) this.startPromise = null;
      })
      .catch(() => undefined);
    return starting;
  }

  private async startEndpoint(): Promise<LanEndpointInfo> {
    const requestedPort = this.options.port ?? 0;
    let boundPort = 0;
    try {
      for (const address of this.collectBindAddresses()) {
        const server = createServer((req, res) => this.handleHttp(req, res));
        server.on("upgrade", (req, socket, head) => this.handleUpgrade(req, socket, head));
        const bound = await new Promise<{ port: number } | null>((resolveListen) => {
          server.once("error", () => resolveListen(null));
          server.listen(boundPort || requestedPort, address, () => {
            const info = server.address();
            resolveListen(info && typeof info === "object" ? { port: info.port } : null);
          });
        });
        if (!bound) {
          server.close();
          continue;
        }
        if (boundPort === 0) {
          boundPort = bound.port;
        } else if (bound.port !== boundPort) {
          server.close();
          continue;
        }
        this.servers.set(address, server);
      }
      if (this.servers.size === 0 || boundPort === 0) {
        throw new Error("Web remote control LAN endpoint failed to bind any address");
      }
      const baseUrls = [...this.servers.keys()].map(
        (address) => `http://${address === "127.0.0.1" ? "127.0.0.1" : address}:${boundPort}/`,
      );
      baseUrls.sort((a, b) => (a.includes("127.0.0.1") ? -1 : b.includes("127.0.0.1") ? 1 : 0));
      this.info = { port: boundPort, baseUrls };
      this.pairSweepTimer = setInterval(() => this.sweepIdlePairs(), 60 * 60 * 1000);
      this.options.logger.info("[web-remote-control] LAN endpoint listening", {
        port: boundPort,
        addresses: [...this.servers.keys()],
      });
      return this.info;
    } catch (error) {
      await this.closeEndpoint();
      throw error;
    }
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    // bind 回调仍会登记 listener；先等它结束再清理，避免 stop 返回后旧 start 复活端点。
    const stopping = (async () => {
      await this.startPromise?.catch(() => undefined);
      await this.closeEndpoint();
    })();
    this.stopPromise = stopping;
    void stopping
      .finally(() => {
        if (this.stopPromise === stopping) this.stopPromise = null;
      })
      .catch(() => undefined);
    return stopping;
  }

  private async closeEndpoint(): Promise<void> {
    if (this.pairSweepTimer) {
      clearInterval(this.pairSweepTimer);
      this.pairSweepTimer = null;
    }
    for (const entry of this.pairs.values()) {
      // close 回调不再重复通知同一配对；wss 持有包括未鉴权在内的全部 socket。
      entry.mobile = undefined;
      entry.device?.handlers.onMobileDisconnected();
    }
    this.pairs.clear();
    for (const client of this.wss.clients) client.close(1001, "endpoint-stopped");
    await Promise.all(
      [...this.servers.values()].map(
        (server) => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
      ),
    );
    this.servers.clear();
    this.info = null;
  }

  /** 创建设备侧会话（桌面用）：register 生成新 sid；persisted 续用（无效则转注册）。 */
  registerDevice(
    auth:
      | { mode: "register"; passHash: string }
      | { mode: "persisted"; deviceSid: string; passHash: string },
    handlers: LanEndpointDeviceHandlers,
  ): LanEndpointDeviceRegistration {
    // device handle 的发送必须落到配对中的手机 socket；空桩会让桌面出站全部静默丢弃。
    const makeHandle = (sid: string): LanEndpointDeviceHandle => {
      const handle: LanEndpointDeviceHandle = {
        deviceSid: sid,
        sendPayload: (payload) =>
          this.pairs.get(sid)?.device?.handle === handle && this.deliverToMobile(sid, payload),
        dispose: () => {
          // 同 SID 可注册新 handle；迟到的旧 dispose 不能摘掉新设备。
          if (this.pairs.get(sid)?.device?.handle === handle) this.releaseDevice(sid);
        },
      };
      return handle;
    };

    if (auth.mode === "persisted") {
      const existing = this.pairs.get(auth.deviceSid);
      if (!existing || existing.passHash !== auth.passHash || existing.device) {
        // 旧 sid 已失效（端点重启 / 停止后重开 / TTL 清扫 / 其他窗口已占用同一 sid）。
        // 只报告不置 error，由调用方清档后转注册流程，见 LanEndpointDeviceRegistration。
        return { ok: false, reason: "invalid-persisted-auth" };
      }
      existing.device = { handle: makeHandle(existing.deviceSid), handlers };
      existing.pairStatus = existing.mobile?.readyState === WebSocket.OPEN ? "matched" : "waiting";
      existing.lastSeenAt = Date.now();
      handlers.onStateChange(existing.pairStatus === "matched" ? "paired" : "waiting_terminal");
      if (existing.mobile?.readyState === WebSocket.OPEN) {
        existing.mobile.send(
          JSON.stringify({ type: "pair_status_ack", pair_status: existing.pairStatus }),
        );
      }
      return { ok: true, handle: existing.device.handle };
    }
    const deviceSid = randomBytes(16).toString("base64url");
    const entry: PairEntry = {
      deviceSid,
      passHash: auth.passHash,
      pairStatus: "waiting",
      lastSeenAt: Date.now(),
    };
    entry.device = { handle: makeHandle(deviceSid), handlers };
    this.pairs.set(deviceSid, entry);
    handlers.onStateChange("registering");
    handlers.onRegisteredAuth({ deviceSid, passHash: auth.passHash });
    this.enterWaitingTerminal(entry);
    return { ok: true, handle: entry.device.handle };
  }

  private enterWaitingTerminal(entry: PairEntry): void {
    entry.pairStatus = "waiting";
    entry.device?.handlers.onStateChange("waiting_terminal");
  }

  private collectBindAddresses(): string[] {
    const addresses = new Set<string>(["127.0.0.1"]);
    for (const list of Object.values(networkInterfaces())) {
      for (const item of list ?? []) {
        if (item.family === "IPv4" && !item.internal) {
          addresses.add(item.address);
        }
      }
    }
    return [...addresses];
  }

  private handleUpgrade(req: IncomingMessage, socket: unknown, head: unknown): void {
    // 关闭多个 listener 期间不再接纳新 socket，避免错过本轮 WebSocket 清理。
    if (this.stopPromise) {
      (socket as { destroy(): void }).destroy();
      return;
    }
    // upgrade 事件中的 URL 解析异常不能逃逸到 Electron Main。
    if (!URL.canParse(req.url ?? "/", "http://localhost")) {
      (socket as { destroy(): void }).destroy();
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== WS_PATH) {
      (socket as { destroy(): void }).destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket as never, head as never, (ws: WebSocket) => {
      attachLanMobileSocket(ws, {
        pairs: this.pairs,
        logger: this.options.logger,
        maxFrameBytes: this.maxFrameBytes,
        handleMobilePayload: this.options.handleMobilePayload,
      });
    });
  }

  /** 端点 → 设备侧的 payload 下发（桌面状态机走这里发给手机）。 */
  deliverToMobile(deviceSid: string, payload: WebRemoteControlAppPayload): boolean {
    const entry = this.pairs.get(deviceSid);
    const mobile = entry?.mobile;
    if (!entry?.device || entry.pairStatus !== "matched" || mobile?.readyState !== WebSocket.OPEN) {
      return false;
    }
    const frame: WebRemoteControlEndpointToClientFrame = { type: "data", payload };
    const serialized = JSON.stringify(frame);
    if (Buffer.byteLength(serialized) > this.maxFrameBytes) {
      this.options.logger.warn("[web-remote-control] dropped oversize app payload", {
        zcodeType: payload.zcode_type,
        bytes: Buffer.byteLength(serialized),
        maxBytes: this.maxFrameBytes,
      });
      return false;
    }
    mobile.send(serialized);
    return true;
  }

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    if (!URL.canParse(req.url ?? "/", "http://localhost")) {
      res.writeHead(400);
      res.end("Bad request");
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          status: "ok",
          pairs: this.pairs.size,
          addresses: [...this.servers.keys()],
        }),
      );
      return;
    }
    void this.staticHandler(url.pathname).then((result) => {
      res.writeHead(result.status, {
        "content-type": result.contentType ?? "text/plain; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(result.body ?? "");
    });
  }

  private sweepIdlePairs(): void {
    const now = Date.now();
    for (const [sid, entry] of this.pairs) {
      if (now - entry.lastSeenAt < PAIR_IDLE_TTL_MS) continue;
      entry.mobile?.close(4003, "pair-expired");
      entry.device?.handlers.onMobileDisconnected();
      this.pairs.delete(sid);
      this.options.logger.info("[web-remote-control] idle pair expired", {
        deviceSidSuffix: sid.slice(-6),
      });
    }
  }
}
