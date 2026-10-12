import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BufferReader, BufferWriter, deserialize, serialize, VSBuffer } from "@zcode/rpc";
import {
  encodeWebRemoteControlRpcFrames,
  WebRemoteControlRpcAssembler,
  WebRemoteControlRpcReplayBuffer,
  type WebRemoteControlAppPayload,
  type ZCodeStreamEvent,
} from "@zcode/shared";
import { MobileRemoteControlClient } from "./protocol.js";
import { TaskConversationLifecycle } from "./taskConversationLifecycle.js";
import { conversationReducer, initialConversationState } from "./conversationReducer.js";

// 与真实 Channel RPC 公共序列化格式一致；不 mock ChannelClient/RemoteServiceAccess。
const PROMISE = 100;
const EVENT_LISTEN = 102;
const EVENT_DISPOSE = 103;
const INITIALIZE = 200;
const SUCCESS = 201;
const EVENT_FIRE = 204;

type BridgeOpen = Extract<WebRemoteControlAppPayload, { zcode_type: "workspace-bridge-open" }>;

class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  sent: WebRemoteControlAppPayload[] = [];
  private listeners = new Map<
    string,
    ((event: { data?: string; code?: number; reason?: string }) => void)[]
  >();
  constructor(_url: string) {
    FakeWebSocket.instances.push(this);
  }
  addEventListener(
    type: string,
    listener: (event: { data?: string; code?: number; reason?: string }) => void,
  ) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  fire(type: string, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.fire("open");
  }
  send(raw: string) {
    const frame = JSON.parse(raw);
    if (frame.type === "data") this.sent.push(frame.payload);
  }
  receive(payload: WebRemoteControlAppPayload) {
    this.wire({ type: "data", payload });
  }
  wire(frame: unknown) {
    this.fire("message", { data: JSON.stringify(frame) });
  }
  close() {
    this.readyState = 3;
    this.fire("close", { code: 1000, reason: "test" });
  }
  opens(): BridgeOpen[] {
    return this.sent.filter((p): p is BridgeOpen => p.zcode_type === "workspace-bridge-open");
  }
  ready(open: BridgeOpen) {
    this.receive({
      zcode_type: "workspace-bridge-ready",
      requestId: open.requestId,
      bridgeSessionId: open.bridgeSessionId,
      bridge: {
        bridgeSessionId: open.bridgeSessionId,
        workspaceKey: open.workspaceKey,
        workspacePath: "/workspace",
        kind: "local",
        entryKind: "task",
      },
    });
  }
}

function rpcBytes(header: number[], body?: unknown) {
  const writer = new BufferWriter();
  serialize(writer, header);
  serialize(writer, body);
  return { __zcodeBytes: btoa(String.fromCharCode(...writer.buffer.buffer)) };
}

function host(socket: FakeWebSocket, streamId: string) {
  let seq = 0;
  return {
    send(header: number[], body?: unknown) {
      seq += 1;
      const frames = encodeWebRemoteControlRpcFrames(rpcBytes(header, body), { streamId, seq });
      for (const frame of frames) socket.receive({ zcode_type: "rpc-frame", frame });
      return frames;
    },
  };
}

function requests(socket: FakeWebSocket, streamId: string) {
  const assembler = new WebRemoteControlRpcAssembler({ streamId });
  const output: { seq: number; header: (number | string)[]; body: unknown }[] = [];
  for (const payload of socket.sent) {
    if (payload.zcode_type !== "rpc-frame" || payload.frame.streamId !== streamId) continue;
    if (payload.frame.kind === "ack") continue;
    for (const event of assembler.push(payload.frame)) {
      if (event.kind !== "message") continue;
      const value = event.message as { __zcodeBytes: string };
      const reader = new BufferReader(
        VSBuffer.wrap(Uint8Array.from(atob(value.__zcodeBytes), (char) => char.charCodeAt(0))),
      );
      output.push({ seq: event.seq, header: deserialize(reader), body: deserialize(reader) });
    }
  }
  return output;
}

async function flush() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}
const clients: MobileRemoteControlClient[] = [];
function client(onPayload = vi.fn<(payload: WebRemoteControlAppPayload) => void>()) {
  const c = new MobileRemoteControlClient(
    { deviceSid: "test-device", passHash: "test-hash", wsUrl: "ws://localhost/ws" },
    {
      onPayload,
      onStateChange: vi.fn(),
    },
  );
  clients.push(c);
  c.connect();
  const socket = FakeWebSocket.instances.at(-1)!;
  socket.open();
  socket.wire({ type: "auth_ack", pair_status: "matched" });
  return { c, socket, onPayload };
}
const access = { workspaceKey: "A", taskId: "task-a", workspacePath: "/workspace" };
const chunk: ZCodeStreamEvent = {
  type: "agent_message_chunk",
  taskId: access.taskId,
  traceId: "trace",
  messageId: "m",
  inputId: "input",
  content: "ha",
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("WebSocket", FakeWebSocket);
  FakeWebSocket.instances = [];
});
afterEach(() => {
  for (const c of clients.splice(0)) c.dispose();
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("MobileRemoteControlClient fake WebSocket", () => {
  it("Initialize 可先于 ready，replayable 订阅使用真实 RPC，重复物理 seq 只交付一次", async () => {
    const { c, socket } = client();
    let state = conversationReducer(initialConversationState, {
      type: "beginScope",
      scope: access,
    });
    state = conversationReducer(state, { type: "applySnapshot", scope: access, messages: [] });
    const listener = vi.fn((event: ZCodeStreamEvent) => {
      state = conversationReducer(state, { type: "streamEvent", scope: access, event });
    });
    const subscription = c.subscribeTaskStream(access, listener);
    await flush();
    const open = socket.opens()[0]!;
    const desktop = host(socket, open.bridgeSessionId);
    desktop.send([INITIALIZE]);
    socket.ready(open);
    await subscription;
    const listen = requests(socket, open.bridgeSessionId)[0]!;
    expect(listen.seq).toBe(1);
    expect(listen.header[0]).toBe(EVENT_LISTEN);
    expect(listen.header[3]).toBe("onDynamicTaskEvent");
    expect(listen.body).toMatchObject({ deliveryKind: "replayable", taskId: access.taskId });
    const frames = desktop.send([EVENT_FIRE, Number(listen.header[1])], chunk);
    for (const frame of frames) socket.receive({ zcode_type: "rpc-frame", frame });
    desktop.send([EVENT_FIRE, Number(listen.header[1])], chunk);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(state.messages[0]?.text).toBe("haha");
    (await subscription).dispose();
  });

  it("degraded 作废旧 RPC，重新 open → Initialize → EventListen → read，不走旧 ready 快路径", async () => {
    let lifecycle!: TaskConversationLifecycle;
    const { c, socket } = client(
      vi.fn((payload) => {
        if (payload.zcode_type === "bridge-degraded") lifecycle.recoverBridge();
      }),
    );
    const onError = vi.fn();
    let state = initialConversationState;
    lifecycle = new TaskConversationLifecycle(access, {
      subscribe: (listener) => c.subscribeTaskStream(access, listener),
      read: () => c.readTaskSnapshot(access),
      dispatch: (action) => {
        state = conversationReducer(state, action);
      },
      onError,
    });
    lifecycle.start();
    await flush();
    const first = socket.opens()[0]!;
    const oldHost = host(socket, first.bridgeSessionId);
    oldHost.send([INITIALIZE]);
    socket.ready(first);
    await flush();
    const firstRequests = requests(socket, first.bridgeSessionId);
    expect(firstRequests.map((r) => r.header[3])).toEqual([
      "onDynamicTaskEvent",
      "readSessionMessages",
    ]);
    socket.receive({
      zcode_type: "bridge-degraded",
      bridgeSessionId: first.bridgeSessionId,
      reason: "rpc-transport-fault",
    });
    await flush();
    expect(socket.opens()).toHaveLength(2);
    expect(state.awaitingSnapshot).toBe(true);
    const second = socket.opens()[1]!;
    // 旧帧不许 Initialize 新 ChannelClient；无新 Initialize 时不发订阅/快照请求。
    oldHost.send([INITIALIZE]);
    socket.ready(second);
    await flush();
    expect(requests(socket, second.bridgeSessionId)).toEqual([]);
    const newHost = host(socket, second.bridgeSessionId);
    newHost.send([INITIALIZE]);
    await flush();
    const secondRequests = requests(socket, second.bridgeSessionId);
    expect(secondRequests.map((r) => r.header[3])).toEqual([
      "onDynamicTaskEvent",
      "readSessionMessages",
    ]);
    expect(secondRequests[0]?.seq).toBe(1);
    expect(secondRequests[0]?.body).toMatchObject({ deliveryKind: "replayable" });
    const read = secondRequests.find((r) => r.header[0] === PROMISE)!;
    oldHost.send([SUCCESS, Number(read.header[1])], [{ invalid: "old" }]);
    newHost.send([SUCCESS, Number(read.header[1])], []);
    await flush();
    expect(state.awaitingSnapshot).toBe(false);
    expect(state.messages).toEqual([]);
    expect(onError).not.toHaveBeenCalled();
    lifecycle.dispose();
  });

  it("deferred A/B/A 的实际 wire open 顺序串行，新桥序号重置且旧帧不进新 client", async () => {
    const { c, socket } = client();
    const readyA = c.ensureWorkspaceBridge({ workspaceKey: "A" });
    await flush();
    const a1 = socket.opens()[0]!;
    const oldHost = host(socket, a1.bridgeSessionId);
    oldHost.send([INITIALIZE]);
    socket.ready(a1);
    await readyA;
    const oldRead = c.readTaskSnapshot(access).catch((error: Error) => error.message);
    await flush();
    const readyB = c
      .ensureWorkspaceBridge({ workspaceKey: "B" })
      .catch((error: Error) => error.message);
    await flush();
    const b = socket.opens()[1]!;
    const readyA2 = c.ensureWorkspaceBridge({ workspaceKey: "A" });
    await flush();
    expect(socket.opens().map((o) => o.workspaceKey)).toEqual(["A", "B"]);
    const lateB = host(socket, b.bridgeSessionId);
    // Host attach 异步：生产 ready 不保证 Initialize 已发送，不能预先见过 B 身份。
    socket.ready(b);
    await flush();
    expect(await readyB).toBe("workspace bridge superseded");
    expect(await oldRead).toBe("mobile bridge invalidated");
    expect(socket.opens().map((o) => o.workspaceKey)).toEqual(["A", "B", "A"]);
    const a2 = socket.opens()[2]!;
    lateB.send([INITIALIZE]);
    oldHost.send([INITIALIZE]);
    const newHost = host(socket, a2.bridgeSessionId);
    socket.ready(a2);
    await readyA2;
    const freshRead = c.readTaskSnapshot(access);
    const settled = vi.fn();
    void freshRead.then(settled);
    await flush();
    expect(requests(socket, a2.bridgeSessionId)).toEqual([]);
    expect(settled).not.toHaveBeenCalled();
    newHost.send([INITIALIZE]);
    await flush();
    const read = requests(socket, a2.bridgeSessionId)[0]!;
    expect(read.seq).toBe(1);
    expect(read.header[3]).toBe("readSessionMessages");
    oldHost.send([SUCCESS, Number(read.header[1])], ["stale-a"]);
    lateB.send([SUCCESS, Number(read.header[1])], ["stale-b"]);
    await flush();
    expect(settled).not.toHaveBeenCalled();
    newHost.send([SUCCESS, Number(read.header[1])], []);
    await flush();
    expect(settled).toHaveBeenCalledWith([]);
    expect(await freshRead).toEqual([]);
  });

  it("手机按 open 身份过滤 ack/flow/分片，双向 ack 不串序号空间", async () => {
    const { c, socket, onPayload } = client();
    const listener = vi.fn();
    const subscription = c.subscribeTaskStream(access, listener);
    await flush();
    const open = socket.opens()[0]!;
    socket.ready(open);
    const stale = encodeWebRemoteControlRpcFrames(
      { stale: "x".repeat(1_100_000) },
      {
        streamId: "unknown-retired-bridge",
        seq: 1,
      },
    );
    expect(stale.length).toBeGreaterThan(1);
    for (const frame of [...stale, ...stale]) socket.receive({ zcode_type: "rpc-frame", frame });
    const acknowledge = vi.spyOn(WebRemoteControlRpcReplayBuffer.prototype, "acknowledge");
    socket.receive({
      zcode_type: "rpc-frame",
      frame: { streamId: "unknown-retired-bridge", kind: "ack", seq: 100, ackSeq: 100 },
    });
    socket.receive({
      zcode_type: "rpc-frame",
      frame: { streamId: "unknown-retired-bridge", kind: "flow", seq: 1, flow: "saturated" },
    });
    expect(acknowledge).not.toHaveBeenCalled();
    expect(onPayload).not.toHaveBeenCalled();
    const desktop = host(socket, open.bridgeSessionId);
    desktop.send([INITIALIZE]);
    const handle = await subscription;
    const listen = requests(socket, open.bridgeSessionId)[0]!;
    desktop.send([EVENT_FIRE, Number(listen.header[1])], chunk);
    desktop.send([EVENT_FIRE, Number(listen.header[1])], chunk);
    // 手机出站只有 EventListen(seq=1)，桌面入站已到 EventFire(seq=3)。
    socket.receive({
      zcode_type: "rpc-frame",
      frame: { streamId: open.bridgeSessionId, kind: "ack", seq: 1, ackSeq: 1 },
    });
    expect(acknowledge).toHaveBeenCalledExactlyOnceWith(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(
      socket.sent.filter((p) => p.zcode_type === "rpc-frame" && p.frame.kind === "ack"),
    ).toContainEqual({
      zcode_type: "rpc-frame",
      frame: { streamId: open.bridgeSessionId, kind: "ack", seq: 3, ackSeq: 3 },
    });
    // 对端 ack 不可推进本端入站水位；下一条 EventFire(seq=4) 仍正常交付。
    desktop.send([EVENT_FIRE, Number(listen.header[1])], chunk);
    expect(listener).toHaveBeenCalledTimes(3);
    handle.dispose();
    expect(requests(socket, open.bridgeSessionId).at(-1)?.header[0]).toBe(EVENT_DISPOSE);
  });

  it("事件回调同步切桥后，旧消息不能给新桥排 ack", async () => {
    const { c, socket } = client();
    let switching!: Promise<void>;
    const subscription = c.subscribeTaskStream(access, () => {
      switching = c.ensureWorkspaceBridge({ workspaceKey: "B" });
    });
    await flush();
    const first = socket.opens()[0]!;
    const oldHost = host(socket, first.bridgeSessionId);
    oldHost.send([INITIALIZE]);
    socket.ready(first);
    await subscription;
    const listen = requests(socket, first.bridgeSessionId)[0]!;
    oldHost.send([EVENT_FIRE, Number(listen.header[1])], chunk);
    await flush();
    const next = socket.opens()[1]!;
    socket.ready(next);
    await switching;
    await vi.advanceTimersByTimeAsync(10);
    expect(
      socket.sent.filter(
        (payload) =>
          payload.zcode_type === "rpc-frame" &&
          payload.frame.streamId === next.bridgeSessionId &&
          payload.frame.kind === "ack",
      ),
    ).toEqual([]);
  });

  it("旧 socket 回调不改新连接状态/信封/RPC", async () => {
    const { c, socket, onPayload } = client();
    socket.close();
    await vi.advanceTimersByTimeAsync(2000);
    const next = FakeWebSocket.instances.at(-1)!;
    expect(next).not.toBe(socket);
    next.open();
    next.wire({ type: "auth_ack", pair_status: "matched" });
    socket.wire({ type: "pair_status_ack", pair_status: "waiting" });
    socket.receive({ zcode_type: "app-error", reason: "unexpectedError", error: "stale" });
    await flush();
    expect(c.getState()).toBe("paired");
    expect(onPayload).not.toHaveBeenCalled();
  });
});
