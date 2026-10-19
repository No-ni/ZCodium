import { createHmac } from "node:crypto";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { LanRemoteControlEndpoint } from "./lanEndpoint.js";

type Frame = { type: string; [key: string]: unknown };
const passHash = "lan-test-pass-hash";
const peers: { socket: WebSocket; frames: Frame[] }[] = [];
let endpoint: LanRemoteControlEndpoint;
let wsUrl: string;
const onPayload = vi.fn();
const onStateChange = vi.fn();

beforeEach(async () => {
  onPayload.mockClear();
  onStateChange.mockClear();
  endpoint = new LanRemoteControlEndpoint({
    logger: { info() {}, warn() {}, error() {} },
    deviceMid: "test-mid",
    deviceName: "test-device",
    appVersion: "test",
    handleMobilePayload: onPayload,
    maxPhysicalFrameBytes: 1024 * 1024,
  });
  const info = await endpoint.start();
  wsUrl = `ws://127.0.0.1:${info.port}/ws`;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    peers.splice(0).map(async ({ socket }) => {
      if (socket.readyState === WebSocket.CLOSED) return;
      const closed = once(socket, "close");
      socket.terminate();
      await closed;
    }),
  );
  await endpoint.stop();
});

function register(deviceSid?: string) {
  const result = endpoint.registerDevice(
    deviceSid ? { mode: "persisted", deviceSid, passHash } : { mode: "register", passHash },
    {
      onStateChange,
      onPayload() {},
      onRegisteredAuth() {},
      onError() {},
      onMobileDisconnected() {},
    },
  );
  if (!result.ok) throw new Error("registration failed");
  return result.handle;
}

async function connect() {
  const socket = new WebSocket(wsUrl);
  const frames: Frame[] = [];
  socket.on("message", (raw) => frames.push(JSON.parse(raw.toString()) as Frame));
  peers.push({ socket, frames });
  await once(socket, "open");
  return {
    socket,
    frames,
    send(frame: unknown) {
      socket.send(JSON.stringify(frame));
    },
    async next(type: string) {
      await vi.waitFor(() => expect(frames.some((frame) => frame.type === type)).toBe(true));
      return frames.splice(
        frames.findIndex((frame) => frame.type === type),
        1,
      )[0]!;
    },
  };
}

type Peer = Awaited<ReturnType<typeof connect>>;
async function challenge(peer: Peer, sid: string) {
  peer.send({ type: "auth_init", role: "mobile", device_sid: sid, client_ts: Date.now() });
  return String((await peer.next("auth_challenge")).nonce);
}
function respond(peer: Peer, sid: string, nonce: string, responseSid = sid) {
  peer.send({
    type: "auth_response",
    device_sid: responseSid,
    client_ts: Date.now(),
    proof: createHmac("sha256", passHash).update(`${nonce}|mobile|${sid}`).digest("base64url"),
  });
}
async function authenticate(peer: Peer, sid: string) {
  respond(peer, sid, await challenge(peer, sid));
  return peer.next("auth_ack");
}

describe("LAN socket authentication and pairing lifecycle", () => {
  it.each([false, true])("停止时关闭未完成鉴权的 socket（challenge=%s）", async (challenged) => {
    const device = register();
    const peer = await connect();
    if (challenged) await challenge(peer, device.deviceSid);
    const stopping = endpoint.stop();
    try {
      await vi.waitFor(() => expect(peer.socket.readyState).toBe(WebSocket.CLOSED));
      await stopping;
    } finally {
      peer.socket.terminate();
      await stopping;
    }
    expect(endpoint.isRunning).toBe(false);
    const restarted = await endpoint.start();
    wsUrl = `ws://127.0.0.1:${restarted.port}/ws`;
    const next = register();
    expect(await authenticate(await connect(), next.deviceSid)).toMatchObject({
      pair_status: "matched",
    });
  });

  it("bind 进行时 stop 等待清理，迟到 start 不会复活端点", async () => {
    await endpoint.stop();
    const starting = endpoint.start();
    const stopping = endpoint.stop();
    await Promise.all([starting, stopping]);
    expect(endpoint.isRunning).toBe(false);
    expect(endpoint.baseUrls).toEqual([]);
  });

  it("stop 期间再次 start 等旧 listener 关闭后重建，设备只收到一次断开", async () => {
    const disconnected = vi.fn();
    const registration = endpoint.registerDevice(
      { mode: "register", passHash },
      {
        onStateChange() {},
        onPayload() {},
        onRegisteredAuth() {},
        onError() {},
        onMobileDisconnected: disconnected,
      },
    );
    if (!registration.ok) throw new Error("registration failed");
    const peer = await connect();
    await authenticate(peer, registration.handle.deviceSid);
    const stopping = endpoint.stop();
    const restarting = endpoint.start();
    await stopping;
    const info = await restarting;
    await vi.waitFor(() => expect(peer.socket.readyState).toBe(WebSocket.CLOSED));
    expect(endpoint.isRunning).toBe(true);
    expect(disconnected).toHaveBeenCalledTimes(1);
    const response = await fetch(`http://127.0.0.1:${info.port}/healthz`);
    expect(await response.json()).toMatchObject({ pairs: 0 });
  });

  it("未鉴权的大消息首片超过物理上限时立即关闭，不等待 fin", async () => {
    const peer = await connect();
    const closed = vi.fn();
    peer.socket.on("close", closed);
    peer.socket.send(Buffer.alloc(1024 * 1024 + 1), { fin: false });
    await vi.waitFor(() => expect(closed).toHaveBeenCalled());
    expect(closed.mock.calls[0]?.[0]).toBe(1009);
  });

  it("并发扫码各自完成鉴权，后配对者只替换已鉴权页面", async () => {
    const device = register();
    const a = await connect();
    const b = await connect();
    const nonceA = await challenge(a, device.deviceSid);
    const nonceB = await challenge(b, device.deviceSid);
    respond(a, device.deviceSid, nonceA);
    expect(await a.next("auth_ack")).toMatchObject({ pair_status: "matched" });
    respond(b, device.deviceSid, nonceB);
    expect(await b.next("auth_ack")).toMatchObject({ pair_status: "matched" });
    expect(await a.next("error")).toMatchObject({ code: "KICKED" });
  });

  it("一个失败 proof 不会清除另一个 socket 的 challenge", async () => {
    const device = register();
    const a = await connect();
    const b = await connect();
    const nonceA = await challenge(a, device.deviceSid);
    await challenge(b, device.deviceSid);
    respond(b, device.deviceSid, "wrong-nonce");
    expect(await b.next("error")).toMatchObject({ code: "AUTH_FAILED" });
    respond(a, device.deviceSid, nonceA);
    expect(await a.next("auth_ack")).toMatchObject({ pair_status: "matched" });
  });

  it("proof 不能使用与 challenge 不一致的 SID", async () => {
    const device = register();
    const peer = await connect();
    const nonce = await challenge(peer, device.deviceSid);
    respond(peer, device.deviceSid, nonce, "different-sid");
    expect(await peer.next("error")).toMatchObject({ code: "AUTH_FAILED" });
  });

  it("过期 challenge 不能重新绑定配对", async () => {
    const device = register();
    const peer = await connect();
    const nonce = await challenge(peer, device.deviceSid);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 60_001);
    respond(peer, device.deviceSid, nonce);
    expect(await peer.next("error")).toMatchObject({ code: "AUTH_FAILED" });
  });

  it("未完成 proof 不允许查询配对", async () => {
    const device = register();
    const peer = await connect();
    await challenge(peer, device.deviceSid);
    peer.send({ type: "pair_status_query", device_sid: device.deviceSid, client_ts: Date.now() });
    expect(await peer.next("error")).toMatchObject({ code: "AUTH_FAILED" });
  });

  it("已鉴权 socket 不能换 SID 再握手，关闭时释放原绑定", async () => {
    const a = register();
    const b = register();
    const peer = await connect();
    await authenticate(peer, a.deviceSid);
    peer.send({
      type: "auth_init",
      role: "mobile",
      device_sid: b.deviceSid,
      client_ts: Date.now(),
    });
    expect(await peer.next("error")).toMatchObject({ code: "WRONG_PARAM" });
    await vi.waitFor(() => expect(peer.socket.readyState).toBe(WebSocket.CLOSED));
    expect(a.sendPayload({ zcode_type: "bootstrap-request", requestId: "stale" })).toBe(false);
  });

  it("设备释放和同 SID 恢复通知 waiting/matched，离线数据不转发且旧 dispose 幂等", async () => {
    const first = register();
    const peer = await connect();
    await authenticate(peer, first.deviceSid);
    first.dispose();
    expect(await peer.next("pair_status_ack")).toMatchObject({ pair_status: "waiting" });
    peer.send({ type: "data", payload: { zcode_type: "bootstrap-request", requestId: "offline" } });
    peer.send({ type: "pair_status_query", device_sid: first.deviceSid, client_ts: Date.now() });
    await peer.next("pair_status_ack");
    expect(onPayload).not.toHaveBeenCalled();

    const second = register(first.deviceSid);
    expect(await peer.next("pair_status_ack")).toMatchObject({ pair_status: "matched" });
    expect(onStateChange).toHaveBeenLastCalledWith("paired");
    first.dispose();
    expect(second.sendPayload({ zcode_type: "bootstrap-request", requestId: "current" })).toBe(
      true,
    );
    peer.send({ type: "data", payload: { zcode_type: "bootstrap-request", requestId: "online" } });
    await vi.waitFor(() =>
      expect(onPayload).toHaveBeenCalledWith(first.deviceSid, {
        zcode_type: "bootstrap-request",
        requestId: "online",
      }),
    );
  });
});
