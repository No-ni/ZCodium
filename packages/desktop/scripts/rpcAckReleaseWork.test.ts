import { EventEmitter } from "node:events";
import type { MessagePortMain } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BufferReader, BufferWriter, deserialize, serialize, VSBuffer } from "@zcode/rpc";
import {
  encodeWebRemoteControlRpcFrames,
  WebRemoteControlRpcAssembler,
  WebRemoteControlRpcReplayBuffer,
  WEB_REMOTE_CONTROL_RPC_FAULT_REASONS,
  WEB_REMOTE_CONTROL_RPC_LIMITS,
  type WebRemoteControlAppPayload,
  type WebRemoteControlRpcMessageFrame,
  type WebRemoteControlRpcTransportFrame,
} from "@zcode/shared";
import { openWebRemoteControlHostBridge } from "../src/main/webRemoteControl/hostBridge.js";
import { MobileRemoteControlClient } from "../../web/src/mobile/protocol.js";

// 仅替换 Electron/WS 容器；两端 ACK 入口、ReplayBuffer、装配和 Channel RPC 都使用生产实现。
vi.mock("electron", () => ({ MessageChannelMain: vi.fn() }));
const cleanups: Array<() => void> = [];
const scope = { workspaceKey: "fixture", taskId: "fixture-task", workspacePath: "/fixture" };
type BridgeOpen = Extract<WebRemoteControlAppPayload, { zcode_type: "workspace-bridge-open" }>;

class FakePort extends EventEmitter {
  postMessage = vi.fn();
  start = vi.fn();
  close = vi.fn(() => {
    this.emit("close");
  });
  fromHost(data: unknown) {
    this.emit("message", { data });
  }
}
class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  sent: WebRemoteControlAppPayload[] = [];
  private listeners = new Map<string, Array<(event: unknown) => void>>();
  constructor(_url: string) {
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, listener: (event: unknown) => void) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  fire(type: string, event: unknown = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  open() {
    this.readyState = 1;
    this.fire("open");
  }
  send(raw: string) {
    const frame = JSON.parse(raw) as { type: string; payload: WebRemoteControlAppPayload };
    if (frame.type === "data") this.sent.push(frame.payload);
  }
  wire(frame: unknown) {
    this.fire("message", { data: JSON.stringify(frame) });
  }
  receive(payload: WebRemoteControlAppPayload) {
    this.wire({ type: "data", payload });
  }
  close() {
    this.readyState = 3;
    this.fire("close", { code: 1000, reason: "fixture" });
  }
  opens() {
    return this.sent.filter((p): p is BridgeOpen => p.zcode_type === "workspace-bridge-open");
  }
  ready(open: BridgeOpen, remoteSessionId?: string) {
    this.receive({
      zcode_type: "workspace-bridge-ready",
      requestId: open.requestId,
      bridgeSessionId: open.bridgeSessionId,
      bridge: {
        bridgeSessionId: open.bridgeSessionId,
        workspaceKey: open.workspaceKey,
        workspacePath: scope.workspacePath,
        entryKind: "task",
        ...(remoteSessionId ? { kind: "remote", remoteSessionId } : { kind: "local" }),
      },
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("WebSocket", FakeWebSocket);
  FakeWebSocket.instances = [];
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function flush() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}
function state(buffer: WebRemoteControlRpcReplayBuffer) {
  return {
    acked: buffer.ackedSeq,
    sent: buffer.lastSentSeq,
    count: buffer.pendingMessageCount,
    bytes: buffer.pendingBytes,
  };
}
function ack(streamId: string, ackSeq: number): WebRemoteControlRpcTransportFrame {
  return { streamId, kind: "ack", seq: ackSeq, ackSeq };
}
function desktop(streamId = "fixture-current") {
  const port = new FakePort();
  const emitted: WebRemoteControlRpcTransportFrame[] = [];
  const onDegraded = vi.fn();
  const opened = openWebRemoteControlHostBridge({
    attachment: {
      attachmentId: "fixture-port",
      port: port as unknown as MessagePortMain,
      dispose: () => port.close(),
    },
    bridgeSessionId: streamId,
    onDegraded,
    logger: { info() {}, warn() {}, error() {} },
    emitFrame({ frame }) {
      emitted.push(frame);
      return true;
    },
  });
  cleanups.push(() => opened.dispose());
  return { ...opened, port, emitted, onDegraded, streamId };
}
function messages(frames: WebRemoteControlRpcTransportFrame[]) {
  return frames.filter(
    (frame): frame is WebRemoteControlRpcMessageFrame => frame.kind === "message",
  );
}
function mobileMessages(socket: FakeWebSocket, streamId: string) {
  return messages(
    socket.sent.flatMap((p) =>
      p.zcode_type === "rpc-frame" && p.frame.streamId === streamId ? [p.frame] : [],
    ),
  );
}
function rpcBytes(header: number[], body?: unknown) {
  const writer = new BufferWriter();
  serialize(writer, header);
  serialize(writer, body);
  return { __zcodeBytes: Buffer.from(writer.buffer.buffer).toString("base64") };
}
function host(socket: FakeWebSocket, streamId: string) {
  let seq = 0;
  return {
    send(header: number[], body?: unknown) {
      for (const frame of encodeWebRemoteControlRpcFrames(rpcBytes(header, body), {
        streamId,
        seq: ++seq,
      })) {
        socket.receive({ zcode_type: "rpc-frame", frame });
      }
    },
  };
}
function requests(socket: FakeWebSocket, streamId: string) {
  const assembler = new WebRemoteControlRpcAssembler({ streamId });
  return mobileMessages(socket, streamId)
    .flatMap((frame) => assembler.push(frame))
    .flatMap((event) => {
      if (event.kind !== "message") return [];
      const reader = new BufferReader(
        VSBuffer.wrap(
          new Uint8Array(
            Buffer.from((event.message as { __zcodeBytes: string }).__zcodeBytes, "base64"),
          ),
        ),
      );
      return [
        {
          seq: event.seq,
          header: deserialize(reader) as Array<number | string>,
          body: deserialize(reader) as unknown,
        },
      ];
    });
}
function mobile() {
  const onPayload = vi.fn();
  const client = new MobileRemoteControlClient(
    { deviceSid: "fixture-device", passHash: "fixture-only", wsUrl: "ws://localhost/fixture" },
    { onPayload, onStateChange: vi.fn() },
  );
  cleanups.push(() => client.dispose());
  client.connect();
  const socket = FakeWebSocket.instances.at(-1)!;
  socket.open();
  socket.wire({ type: "auth_ack", pair_status: "matched" });
  return { client, socket, onPayload };
}
async function openMobile(h: ReturnType<typeof mobile>, remoteSessionId?: string) {
  const opening = h.client.ensureWorkspaceBridge({ ...scope, remoteSessionId });
  await flush();
  const open = h.socket.opens().at(-1)!;
  h.socket.ready(open, remoteSessionId);
  await opening;
  const sender = host(h.socket, open.bridgeSessionId);
  sender.send([200]);
  await flush();
  return { open, sender };
}
function owner(record: ReturnType<typeof observeRecord>) {
  const buffer = record.mock.contexts.at(-1) as WebRemoteControlRpcReplayBuffer;
  expect(buffer).toBeInstanceOf(WebRemoteControlRpcReplayBuffer);
  return buffer;
}
function observeRecord() {
  return vi.spyOn(WebRemoteControlRpcReplayBuffer.prototype, "record");
}

describe("production ACK release-only seams", () => {
  it("Desktop normal/repeated/old ACKs release only; gap replay keeps the original tail and inbound seq", () => {
    const record = observeRecord();
    const h = desktop();
    for (let n = 1; n <= 3; n += 1) h.port.fromHost(`host-${n}`);
    const buffer = owner(record);
    record.mockRestore();
    const acknowledge = vi.spyOn(buffer, "acknowledge");
    const replay = vi.spyOn(buffer, "replayUnacknowledged");
    const original = messages(h.emitted);
    const before = state(buffer);
    h.bridge.acceptFrame(ack("fixture-retired", 2));
    expect(acknowledge).not.toHaveBeenCalled();
    expect(state(buffer)).toEqual(before);
    for (const seq of [1, 1, 0, 4]) h.bridge.acceptFrame(ack(h.streamId, seq));
    expect(acknowledge.mock.calls).toEqual([
      [1, false],
      [1, false],
      [0, false],
      [4, false],
    ]);
    expect(replay).not.toHaveBeenCalled();
    expect(h.emitted).toHaveLength(3);
    expect(state(buffer)).toMatchObject({ acked: 1, sent: 3, count: 2 });
    expect(buffer.pendingBytes).toBeLessThan(before.bytes);
    h.bridge.acceptFrame(encodeWebRemoteControlRpcFrames({}, { streamId: h.streamId, seq: 2 })[0]!);
    expect(replay).toHaveBeenCalledOnce();
    const tail = messages(h.emitted.slice(3));
    expect(tail).toEqual(original.slice(1));
    for (const [index, frame] of tail.entries()) expect(frame).toBe(original[index + 1]);
    expect(h.onDegraded).toHaveBeenCalledExactlyOnceWith(
      WEB_REMOTE_CONTROL_RPC_FAULT_REASONS.frameGap,
    );
    h.bridge.acceptFrame(
      encodeWebRemoteControlRpcFrames("mobile-1", { streamId: h.streamId, seq: 1 })[0]!,
    );
    expect(h.port.postMessage).toHaveBeenCalledExactlyOnceWith("mobile-1");
    vi.advanceTimersByTime(WEB_REMOTE_CONTROL_RPC_LIMITS.ackCoalesceWindowMs);
    expect(h.emitted.at(-1)).toEqual(ack(h.streamId, 1));
    h.bridge.dispose();
    expect(state(buffer)).toEqual({ acked: 0, sent: 0, count: 0, bytes: 0 });
    const calls = acknowledge.mock.calls.length;
    h.bridge.acceptFrame(ack(h.streamId, 3));
    expect(acknowledge).toHaveBeenCalledTimes(calls);
  });

  it("Desktop release-only ACK restores a full production count window without skipping rejected seq", () => {
    const record = observeRecord();
    const h = desktop();
    for (let n = 1; n <= WEB_REMOTE_CONTROL_RPC_LIMITS.replayBufferMaxMessages; n += 1)
      h.port.fromHost("value");
    const buffer = owner(record);
    record.mockRestore();
    const replay = vi.spyOn(buffer, "replayUnacknowledged");
    h.port.fromHost("overflow");
    expect(h.onDegraded).toHaveBeenLastCalledWith(
      WEB_REMOTE_CONTROL_RPC_FAULT_REASONS.replayBufferOverflow,
    );
    expect(state(buffer)).toMatchObject({ acked: 0, sent: 128, count: 128 });
    expect(messages(h.emitted)).toHaveLength(128);
    h.bridge.acceptFrame(ack("fixture-retired", 1));
    expect(buffer.pendingMessageCount).toBe(128);
    h.bridge.acceptFrame(ack(h.streamId, 1));
    expect(buffer.pendingMessageCount).toBe(127);
    h.port.fromHost("restored");
    expect(state(buffer)).toMatchObject({ acked: 1, sent: 129, count: 128 });
    expect(messages(h.emitted).at(-1)?.seq).toBe(129);
    expect(replay).not.toHaveBeenCalled();
  });

  it("Desktop timeout still explicitly replays the unacknowledged tail after release-only ACK", () => {
    const record = observeRecord();
    const h = desktop();
    h.port.fromHost("one");
    h.port.fromHost("two");
    const buffer = owner(record);
    record.mockRestore();
    const original = messages(h.emitted);
    const replay = vi.spyOn(buffer, "replayUnacknowledged");
    h.bridge.acceptFrame(ack(h.streamId, 1));
    expect(replay).not.toHaveBeenCalled();
    const fragmented = encodeWebRemoteControlRpcFrames(
      { partial: "x".repeat(900_000) },
      { streamId: h.streamId, seq: 1 },
    );
    expect(fragmented.length).toBeGreaterThan(1);
    h.bridge.acceptFrame(fragmented[0]!);
    vi.advanceTimersByTime(
      WEB_REMOTE_CONTROL_RPC_LIMITS.assemblyTimeoutMs +
        WEB_REMOTE_CONTROL_RPC_LIMITS.assemblySweepIntervalMs,
    );
    expect(h.onDegraded).toHaveBeenCalledExactlyOnceWith(
      WEB_REMOTE_CONTROL_RPC_FAULT_REASONS.bufferTimeout,
    );
    expect(replay).toHaveBeenCalledOnce();
    expect(messages(h.emitted.slice(2))).toEqual([original[1]]);
    expect(messages(h.emitted.slice(2))[0]).toBe(original[1]);
    expect(h.port.postMessage).not.toHaveBeenCalled();
  });

  it("Desktop attachment close clears the real window and ignores late ACKs", () => {
    const record = observeRecord();
    const h = desktop();
    h.port.fromHost("pending");
    const buffer = owner(record);
    record.mockRestore();
    const acknowledge = vi.spyOn(buffer, "acknowledge");
    h.port.close();
    expect(state(buffer)).toEqual({ acked: 0, sent: 0, count: 0, bytes: 0 });
    h.bridge.acceptFrame(ack(h.streamId, 1));
    expect(acknowledge).not.toHaveBeenCalled();
    expect(h.onDegraded).toHaveBeenCalledExactlyOnceWith("host-attachment-port-closed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("mobile normal/repeated/old ACKs do no replay work or resend, and do not advance inbound events", async () => {
    const h = mobile();
    const { open, sender } = await openMobile(h);
    const record = observeRecord();
    const listener = vi.fn();
    await h.client.subscribeTaskStream(scope, listener);
    await h.client.subscribeTaskStream(scope, vi.fn());
    const buffer = owner(record);
    record.mockRestore();
    const acknowledge = vi.spyOn(buffer, "acknowledge");
    const replay = vi.spyOn(buffer, "replayUnacknowledged");
    const before = state(buffer);
    const original = mobileMessages(h.socket, open.bridgeSessionId);
    h.socket.receive({ zcode_type: "rpc-frame", frame: ack("fixture-retired", 2) });
    expect(acknowledge).not.toHaveBeenCalled();
    expect(state(buffer)).toEqual(before);
    for (const seq of [3, 1, 1, 0])
      h.socket.receive({ zcode_type: "rpc-frame", frame: ack(open.bridgeSessionId, seq) });
    expect(acknowledge.mock.calls).toEqual([
      [3, false],
      [1, false],
      [1, false],
      [0, false],
    ]);
    expect(replay).not.toHaveBeenCalled();
    expect(mobileMessages(h.socket, open.bridgeSessionId)).toEqual(original);
    expect(state(buffer)).toMatchObject({ acked: 1, sent: 2, count: 1 });
    expect(buffer.pendingBytes).toBeLessThan(before.bytes);
    expect(buffer.replayUnacknowledged()).toEqual([original[1]]);
    const listen = requests(h.socket, open.bridgeSessionId)[0]!;
    sender.send([204, Number(listen.header[1])], { type: "fixture-event" });
    expect(listener).toHaveBeenCalledExactlyOnceWith({ type: "fixture-event" });
    expect(h.onPayload).not.toHaveBeenCalled();
    h.socket.close();
    expect(state(buffer)).toEqual({ acked: 0, sent: 0, count: 0, bytes: 0 });
  });

  it("mobile old bridge/generation ACK cannot release the new same-key remote window", async () => {
    const h = mobile();
    const first = await openMobile(h, "fixture-remote-A");
    const record = observeRecord();
    await h.client.subscribeTaskStream({ ...scope, remoteSessionId: "fixture-remote-A" }, vi.fn());
    const buffer = owner(record);
    const second = await openMobile(h, "fixture-remote-B");
    await h.client.subscribeTaskStream({ ...scope, remoteSessionId: "fixture-remote-B" }, vi.fn());
    expect(owner(record)).toBe(buffer);
    record.mockRestore();
    expect(second.open.bridgeSessionId).not.toBe(first.open.bridgeSessionId);
    const acknowledge = vi.spyOn(buffer, "acknowledge");
    const replay = vi.spyOn(buffer, "replayUnacknowledged");
    const before = state(buffer);
    expect(before).toMatchObject({ acked: 0, sent: 1, count: 1 });
    h.socket.receive({ zcode_type: "rpc-frame-ack", frame: ack(first.open.bridgeSessionId, 1) });
    expect(acknowledge).not.toHaveBeenCalled();
    expect(state(buffer)).toEqual(before);
    const sent = h.socket.sent.length;
    h.socket.receive({ zcode_type: "rpc-frame-ack", frame: ack(second.open.bridgeSessionId, 1) });
    expect(acknowledge).toHaveBeenCalledExactlyOnceWith(1, false);
    expect(state(buffer)).toEqual({ acked: 1, sent: 1, count: 0, bytes: 0 });
    expect(h.socket.sent).toHaveLength(sent);
    expect(replay).not.toHaveBeenCalled();
    h.socket.close();
    h.client.acceptRpcFrame(ack(second.open.bridgeSessionId, 1));
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(state(buffer)).toEqual({ acked: 0, sent: 0, count: 0, bytes: 0 });
  });

  it("mobile ACK releases production capacity before the next real EventListen admission", async () => {
    const h = mobile();
    const { open } = await openMobile(h);
    const record = observeRecord();
    for (let n = 1; n <= WEB_REMOTE_CONTROL_RPC_LIMITS.replayBufferMaxMessages; n += 1) {
      await h.client.subscribeTaskStream(scope, vi.fn());
    }
    const buffer = owner(record);
    record.mockRestore();
    const replay = vi.spyOn(buffer, "replayUnacknowledged");
    expect(state(buffer)).toMatchObject({ acked: 0, sent: 128, count: 128 });
    h.socket.receive({ zcode_type: "rpc-frame", frame: ack("fixture-retired", 1) });
    expect(buffer.pendingMessageCount).toBe(128);
    h.socket.receive({ zcode_type: "rpc-frame", frame: ack(open.bridgeSessionId, 1) });
    expect(buffer.pendingMessageCount).toBe(127);
    await h.client.subscribeTaskStream(scope, vi.fn());
    expect(state(buffer)).toMatchObject({ acked: 1, sent: 129, count: 128 });
    expect(mobileMessages(h.socket, open.bridgeSessionId)).toHaveLength(129);
    expect(mobileMessages(h.socket, open.bridgeSessionId).at(-1)?.seq).toBe(129);
    expect(h.onPayload).not.toHaveBeenCalled();
    h.socket.receive({ zcode_type: "rpc-frame", frame: ack(open.bridgeSessionId, 129) });
    expect(buffer.pendingMessageCount).toBe(0);
    expect(replay).not.toHaveBeenCalled();
  });
});
