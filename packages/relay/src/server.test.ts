import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { startRelayServer, type RelayServerHandle } from "./server.js";

type RelayFrame = { type: string; [key: string]: unknown };

class RelayPeer {
  readonly socket: WebSocket;
  private readonly frames: RelayFrame[] = [];
  private readonly waiters: {
    type: string;
    resolve: (frame: RelayFrame) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }[] = [];

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as RelayFrame;
      const index = this.waiters.findIndex((waiter) => waiter.type === frame.type);
      if (index < 0) {
        this.frames.push(frame);
        return;
      }
      const [waiter] = this.waiters.splice(index, 1);
      clearTimeout(waiter!.timer);
      waiter!.resolve(frame);
    });
    this.socket.on("error", () => {});
  }

  send(frame: unknown): void {
    this.socket.send(JSON.stringify(frame));
  }

  next(type: string): Promise<RelayFrame> {
    const index = this.frames.findIndex((frame) => frame.type === type);
    if (index >= 0) return Promise.resolve(this.frames.splice(index, 1)[0]!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiterIndex = this.waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (waiterIndex >= 0) this.waiters.splice(waiterIndex, 1);
        reject(new Error(`Timed out waiting for relay frame: ${type}`));
      }, 2_000);
      this.waiters.push({ type, resolve, reject, timer });
    });
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      this.socket.once("close", () => resolve());
      if (this.socket.readyState === WebSocket.OPEN) this.socket.close();
      else this.socket.terminate();
    });
  }
}

const logger = { info() {}, warn() {} };
const peers: RelayPeer[] = [];
let relay: RelayServerHandle;

beforeEach(async () => {
  relay = await startRelayServer({
    port: 0,
    host: "127.0.0.1",
    path: "/ws",
    maxPhysicalFrameBytes: 2_000_000,
    pairTtlMs: 60_000,
    mobileDir: null,
    logger,
    rateLimiter: { allowConnect: () => true, allowFrame: () => true },
  });
});

afterEach(async () => {
  await Promise.all(peers.splice(0).map((peer) => peer.close()));
  await relay.close();
});

function connect(): RelayPeer {
  const peer = new RelayPeer(`ws://127.0.0.1:${relay.port}/ws`);
  peers.push(peer);
  return peer;
}

function proof(passHash: string, nonce: string, role: "device" | "mobile", sid: string): string {
  return createHmac("sha256", passHash).update(`${nonce}|${role}|${sid}`).digest("base64url");
}

async function registerDevice(passHash: string): Promise<{ peer: RelayPeer; sid: string }> {
  const peer = connect();
  await new Promise<void>((resolve) => peer.socket.once("open", resolve));
  peer.send({
    type: "device_register_init",
    device_mid: "test-device",
    pass_hash: passHash,
    client_ts: Date.now(),
  });
  const registered = await peer.next("device_register_ack");
  const sid = String(registered.device_sid);
  peer.send({ type: "auth_init", role: "device", device_sid: sid, client_ts: Date.now() });
  const challenge = await peer.next("auth_challenge");
  peer.send({
    type: "auth_response",
    device_sid: sid,
    proof: proof(passHash, String(challenge.nonce), "device", sid),
    client_ts: Date.now(),
  });
  await peer.next("auth_ack");
  return { peer, sid };
}

async function authenticate(
  peer: RelayPeer,
  sid: string,
  passHash: string,
  role: "device" | "mobile",
): Promise<RelayFrame> {
  peer.send({ type: "auth_init", role, device_sid: sid, client_ts: Date.now() });
  const challenge = await peer.next("auth_challenge");
  peer.send({
    type: "auth_response",
    device_sid: sid,
    proof: proof(passHash, String(challenge.nonce), role, sid),
    client_ts: Date.now(),
  });
  return peer.next("auth_ack");
}

describe("relay server socket authentication", () => {
  it("rejects oversized unfinished WebSocket fragments before authentication", async () => {
    const peer = connect();
    await new Promise<void>((resolve) => peer.socket.once("open", resolve));
    const closed = new Promise<number>((resolve) => peer.socket.once("close", resolve));
    peer.socket.send(Buffer.alloc(2_000_001), { fin: false });
    const code = await Promise.race([
      closed,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
    ]);
    expect(code).toBe(1009);
  });

  it("rejects data and status queries before the socket proves its challenge", async () => {
    const { sid } = await registerDevice("hash-A");

    const dataPeer = connect();
    await new Promise<void>((resolve) => dataPeer.socket.once("open", resolve));
    dataPeer.send({ type: "auth_init", role: "mobile", device_sid: sid, client_ts: Date.now() });
    await dataPeer.next("auth_challenge");
    dataPeer.send({ type: "data", payload: { zcode_type: "bootstrap-request" } });
    expect(await dataPeer.next("error")).toMatchObject({ code: "AUTH_FAILED" });

    const queryPeer = connect();
    await new Promise<void>((resolve) => queryPeer.socket.once("open", resolve));
    queryPeer.send({ type: "auth_init", role: "mobile", device_sid: sid, client_ts: Date.now() });
    await queryPeer.next("auth_challenge");
    queryPeer.send({ type: "pair_status_query", device_sid: sid, client_ts: Date.now() });
    expect(await queryPeer.next("error")).toMatchObject({ code: "AUTH_FAILED" });
  });

  it("ignores an auth_response queued after the server has started closing the socket", async () => {
    const { peer: device, sid } = await registerDevice("hash-A");
    const attacker = connect();
    await new Promise<void>((resolve) => attacker.socket.once("open", resolve));
    attacker.send({ type: "auth_init", role: "mobile", device_sid: sid, client_ts: Date.now() });
    const challenge = await attacker.next("auth_challenge");
    attacker.send({ type: "data", payload: { zcode_type: "unauthorized" } });
    attacker.send({
      type: "auth_response",
      device_sid: sid,
      proof: proof("hash-A", String(challenge.nonce), "mobile", sid),
      client_ts: Date.now(),
    });
    expect(await attacker.next("error")).toMatchObject({ code: "AUTH_FAILED" });
    device.send({ type: "pair_status_query", device_sid: sid, client_ts: Date.now() });
    expect(await device.next("pair_status_ack")).toMatchObject({ pair_status: "waiting" });
  });

  it("isolates concurrent challenges to their sockets", async () => {
    const { sid } = await registerDevice("hash-A");
    const first = connect();
    const second = connect();
    await Promise.all(
      [first, second].map(
        (peer) => new Promise<void>((resolve) => peer.socket.once("open", resolve)),
      ),
    );
    first.send({ type: "auth_init", role: "mobile", device_sid: sid, client_ts: Date.now() });
    const firstChallenge = await first.next("auth_challenge");
    second.send({ type: "auth_init", role: "mobile", device_sid: sid, client_ts: Date.now() });
    const secondChallenge = await second.next("auth_challenge");

    first.send({
      type: "auth_response",
      device_sid: sid,
      proof: proof("hash-A", String(firstChallenge.nonce), "mobile", sid),
      client_ts: Date.now(),
    });
    expect(await first.next("auth_ack")).toMatchObject({ pair_status: "matched" });
    second.send({
      type: "auth_response",
      device_sid: sid,
      proof: proof("hash-A", String(secondChallenge.nonce), "mobile", sid),
      client_ts: Date.now(),
    });
    expect(await second.next("auth_ack")).toMatchObject({ pair_status: "matched" });
    expect(await first.next("error")).toMatchObject({ code: "KICKED" });
  });

  it("rejects a response whose sid differs from the challenged entry", async () => {
    const { sid: sidA } = await registerDevice("hash-A");
    const { sid: sidB } = await registerDevice("hash-B");
    const peer = connect();
    await new Promise<void>((resolve) => peer.socket.once("open", resolve));
    peer.send({ type: "auth_init", role: "mobile", device_sid: sidA, client_ts: Date.now() });
    const challenge = await peer.next("auth_challenge");
    peer.send({
      type: "auth_response",
      device_sid: sidB,
      proof: proof("hash-A", String(challenge.nonce), "mobile", sidA),
      client_ts: Date.now(),
    });
    expect(await peer.next("error")).toMatchObject({ code: "AUTH_FAILED" });
  });

  it("does not let an authenticated socket switch sid or role with another auth_init", async () => {
    const { peer: device, sid } = await registerDevice("hash-A");
    const mobile = connect();
    await new Promise<void>((resolve) => mobile.socket.once("open", resolve));
    await authenticate(mobile, sid, "hash-A", "mobile");
    await device.next("pair_status_ack");
    mobile.send({ type: "auth_init", role: "device", device_sid: sid, client_ts: Date.now() });
    expect(await mobile.next("error")).toMatchObject({ code: "AUTH_FAILED" });
    await new Promise<void>((resolve) => mobile.socket.once("close", () => resolve()));
    device.send({ type: "pair_status_query", device_sid: sid, client_ts: Date.now() });
    expect(await device.next("pair_status_ack")).toMatchObject({ pair_status: "waiting" });
  });

  it("rejects unauthenticated, mobile, and cross-sid unregister while allowing the bound device", async () => {
    const { peer: deviceA, sid: sidA } = await registerDevice("hash-A");
    const { sid: sidB } = await registerDevice("hash-B");
    const mobile = connect();
    await new Promise<void>((resolve) => mobile.socket.once("open", resolve));
    await authenticate(mobile, sidA, "hash-A", "mobile");
    mobile.send({ type: "device_unregister", device_sid: sidA });
    expect(await mobile.next("error")).toMatchObject({ code: "AUTH_FAILED" });

    const unauthorized = connect();
    await new Promise<void>((resolve) => unauthorized.socket.once("open", resolve));
    unauthorized.send({ type: "device_unregister", device_sid: sidA });
    expect(await unauthorized.next("error")).toMatchObject({ code: "AUTH_FAILED" });

    const deviceB = connect();
    await new Promise<void>((resolve) => deviceB.socket.once("open", resolve));
    await authenticate(deviceB, sidB, "hash-B", "device");
    deviceB.send({ type: "device_unregister", device_sid: sidA });
    expect(await deviceB.next("error")).toMatchObject({ code: "AUTH_FAILED" });

    const deviceClosed = new Promise<void>((resolve) =>
      deviceA.socket.once("close", () => resolve()),
    );
    deviceA.send({ type: "device_unregister", device_sid: sidA });
    await deviceClosed;

    const staleSid = connect();
    await new Promise<void>((resolve) => staleSid.socket.once("open", resolve));
    staleSid.send({ type: "auth_init", role: "mobile", device_sid: sidA, client_ts: Date.now() });
    expect(await staleSid.next("error")).toMatchObject({ code: "AUTH_FAILED" });
  });

  it("derives waiting from current open sockets and notifies mobile on device recovery", async () => {
    const { peer: device, sid } = await registerDevice("hash-A");
    const mobile = connect();
    await new Promise<void>((resolve) => mobile.socket.once("open", resolve));
    expect(await authenticate(mobile, sid, "hash-A", "mobile")).toMatchObject({
      pair_status: "matched",
    });

    device.socket.terminate();
    await mobile
      .next("pair_status_ack")
      .then((frame) => expect(frame).toMatchObject({ pair_status: "waiting" }));
    mobile.send({ type: "data", payload: { zcode_type: "offline-must-drop" } });
    mobile.send({ type: "pair_status_query", device_sid: sid, client_ts: Date.now() });
    expect(await mobile.next("pair_status_ack")).toMatchObject({ pair_status: "waiting" });

    const restoredDevice = connect();
    await new Promise<void>((resolve) => restoredDevice.socket.once("open", resolve));
    restoredDevice.send({
      type: "auth_init",
      role: "device",
      device_sid: sid,
      client_ts: Date.now(),
    });
    const challenge = await restoredDevice.next("auth_challenge");
    restoredDevice.send({
      type: "auth_response",
      device_sid: sid,
      proof: proof("hash-A", String(challenge.nonce), "device", sid),
      client_ts: Date.now(),
    });
    expect(await restoredDevice.next("auth_ack")).toMatchObject({ pair_status: "matched" });
    expect(await mobile.next("pair_status_ack")).toMatchObject({ pair_status: "matched" });

    mobile.send({ type: "data", payload: { zcode_type: "valid" } });
    expect(await restoredDevice.next("data")).toMatchObject({
      payload: { zcode_type: "valid" },
    });
  });

  it.each(["device", "mobile"] as const)(
    "replacement of %s notifies peer waiting then matched",
    async (role) => {
      const { peer: device, sid } = await registerDevice("hash-A");
      const mobile = connect();
      await new Promise<void>((resolve) => mobile.socket.once("open", resolve));
      await authenticate(mobile, sid, "hash-A", "mobile");
      await device.next("pair_status_ack");
      const peer = role === "device" ? mobile : device;
      const old = role === "device" ? device : mobile;
      const closed = new Promise<void>((resolve) => old.socket.once("close", () => resolve()));
      const replacement = connect();
      await new Promise<void>((resolve) => replacement.socket.once("open", resolve));
      await authenticate(replacement, sid, "hash-A", role);
      expect(await peer.next("pair_status_ack")).toMatchObject({ pair_status: "waiting" });
      expect(await peer.next("pair_status_ack")).toMatchObject({ pair_status: "matched" });
      await closed;
      peer.send({ type: "pair_status_query", device_sid: sid, client_ts: Date.now() });
      expect(await peer.next("pair_status_ack")).toMatchObject({ pair_status: "matched" });
      peer.send({ type: "data", payload: { zcode_type: "current-binding" } });
      expect(await replacement.next("data")).toMatchObject({
        payload: { zcode_type: "current-binding" },
      });
    },
  );

  it("closing a replaced device socket does not mark the replacement offline", async () => {
    const { peer: oldDevice, sid } = await registerDevice("hash-A");
    const mobile = connect();
    await new Promise<void>((resolve) => mobile.socket.once("open", resolve));
    await authenticate(mobile, sid, "hash-A", "mobile");

    const newDevice = connect();
    await new Promise<void>((resolve) => newDevice.socket.once("open", resolve));
    expect(await authenticate(newDevice, sid, "hash-A", "device")).toMatchObject({
      pair_status: "matched",
    });
    expect(await mobile.next("pair_status_ack")).toMatchObject({ pair_status: "waiting" });
    expect(await mobile.next("pair_status_ack")).toMatchObject({ pair_status: "matched" });
    await new Promise<void>((resolve) => oldDevice.socket.once("close", () => resolve()));

    mobile.send({ type: "pair_status_query", device_sid: sid, client_ts: Date.now() });
    expect(await mobile.next("pair_status_ack")).toMatchObject({ pair_status: "matched" });
    mobile.send({ type: "data", payload: { zcode_type: "after-rebind" } });
    expect(await newDevice.next("data")).toMatchObject({
      payload: { zcode_type: "after-rebind" },
    });
  });
});
