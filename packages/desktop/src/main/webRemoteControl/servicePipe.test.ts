import { describe, expect, it, vi } from "vitest";
import {
  ChannelClient,
  ChannelServer,
  Emitter,
  MessagePortProtocol,
  ProxyChannel,
  VSBuffer,
  type IChannel,
  type IMessagePassingProtocol,
  type MessagePortLike,
  type MessagePortPayload,
} from "@zcode/rpc";
import {
  encodeWebRemoteControlRpcFrames,
  WebRemoteControlRpcAssembler,
  type WebRemoteControlRpcTransportFrame,
} from "@zcode/shared";
import { createWebRemoteControlServicePipe } from "./servicePipe.js";
import { openWebRemoteControlHostBridge } from "./hostBridge.js";

// 测试只替换 Electron 容器；Host bridge、装配器和 Channel RPC 均用生产实现。
vi.mock("electron", () => ({ MessageChannelMain: vi.fn() }));

/**
 * servicePipe 回归测试：证明「手机 → Host」是真实的一条 RPC 链路。
 *
 * 拓扑与线上一致（只是把 WS 换成进程内直连）：
 *
 *   Host ChannelServer ── MessagePortProtocol(serverPort) ──┐
 *                                                           │ fake port pair
 *   （main）servicePipe ◀──── hostPort ◀────────────────────┘
 *        │  sendToMobile: 编码分片 → 装配器（手机接收侧）
 *        ▼
 *   手机侧 IMessagePassingProtocol ── ChannelClient / ProxyChannel.toService
 *
 * 关键回归点：以前 main 也建了一个 ChannelClient，链路两端都是客户端、没有服务端，
 * 手机侧永远收不到 Initialize，调用永远不 settle。这里用真实 ChannelServer 作对端，
 * 只要转发断了就会超时失败。
 */

interface StubServiceShape {
  echo(value: string): Promise<string>;
  repeat(value: string): Promise<string>;
  onDidPing(listener: (value: string) => void): { dispose(): void };
}

function toJsonSafe(payload: MessagePortPayload | Uint8Array): unknown {
  if (payload instanceof Uint8Array) {
    return { __zcodeBytes: Buffer.from(payload).toString("base64") };
  }
  return payload;
}

function jsonSafeToPortPayload(value: unknown): Uint8Array {
  if (value && typeof value === "object" && "__zcodeBytes" in (value as object)) {
    const base64 = (value as { __zcodeBytes?: unknown }).__zcodeBytes;
    if (typeof base64 === "string") return new Uint8Array(Buffer.from(base64, "base64"));
  }
  throw new Error("unexpected non-binary rpc payload in servicePipe test");
}

type PortListener = (event: { data: MessagePortPayload }) => void;
type PortCloseListener = () => void;

interface FakeMessagePort extends MessagePortLike {
  on(type: string, listener: PortListener | PortCloseListener): void;
  off(type: string, listener: PortListener | PortCloseListener): void;
}

/** 内存 MessagePort 对：postMessage 异步投递到对端监听者，模拟 MessagePort 的消息边界。 */
function createFakePortPair(): { a: FakeMessagePort; b: FakeMessagePort } {
  const listenersA = new Set<PortListener>();
  const listenersB = new Set<PortListener>();
  const closeListenersA = new Set<PortCloseListener>();
  const closeListenersB = new Set<PortCloseListener>();
  let closed = false;
  const make = (
    own: Set<PortListener>,
    peer: Set<PortListener>,
    ownClose: Set<PortCloseListener>,
    peerClose: Set<PortCloseListener>,
  ): FakeMessagePort => ({
    addEventListener(_type: "message", listener: PortListener) {
      own.add(listener);
    },
    removeEventListener(_type: "message", listener: PortListener) {
      own.delete(listener);
    },
    on(type: string, listener: PortListener | PortCloseListener) {
      if (type === "message") own.add(listener as PortListener);
      else if (type === "close") ownClose.add(listener as PortCloseListener);
    },
    off(type: string, listener: PortListener | PortCloseListener) {
      if (type === "message") own.delete(listener as PortListener);
      else if (type === "close") ownClose.delete(listener as PortCloseListener);
    },
    postMessage(data: MessagePortPayload) {
      setTimeout(() => {
        if (closed) return;
        // 投递时再取快照：真实 MessagePort 的事件只送给“触发时已注册”的监听者。
        const recipients = Array.from(peer);
        for (const listener of recipients) listener({ data });
      }, 0);
    },
    start() {},
    close() {
      if (closed) return;
      closed = true;
      own.clear();
      peer.clear();
      for (const listener of [...ownClose, ...peerClose]) listener();
      ownClose.clear();
      peerClose.clear();
    },
  });
  return {
    a: make(listenersA, listenersB, closeListenersA, closeListenersB),
    b: make(listenersB, listenersA, closeListenersB, closeListenersA),
  };
}

function createHarness() {
  // a = Host 进程侧的 port；b = main 侧的 Host port。
  const { a: serverPort, b: hostPort } = createFakePortPair();

  const pingEmitter = new Emitter<string>();
  const pingSubscribed = { value: false };
  const stub = {
    echo: async (value: string) => `echo:${value}`,
    repeat: async (value: string) => value,
    // 记录 Host 侧是否真的建立订阅；EventListen 是异步到达的，用它消除竞态。
    onDidPing: (listener: (value: string) => void) => {
      pingSubscribed.value = true;
      return pingEmitter.event(listener);
    },
  };
  const serverProtocol = new MessagePortProtocol(serverPort);
  const server = new ChannelServer(serverProtocol, "test-ctx");
  server.registerChannel("test-channel", ProxyChannel.fromService(stub));

  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const desktopSeq = { value: 0 };
  const mobileSeq = { value: 0 };
  const mainToMobileAssembler = new WebRemoteControlRpcAssembler();
  const mobileToMainAssembler = new WebRemoteControlRpcAssembler();
  const mobileMessageEmitter = new Emitter<VSBuffer>();

  const pipe = createWebRemoteControlServicePipe({
    hostPort,
    attachmentId: "attachment-test",
    logger,
    // 桌面 → 手机：走真实的分片 + 装配层，不是裸转发。
    sendToMobile(payload) {
      desktopSeq.value += 1;
      const frames = encodeWebRemoteControlRpcFrames(toJsonSafe(payload), {
        streamId: "desktop-test",
        seq: desktopSeq.value,
      });
      for (const frame of frames) {
        for (const event of mainToMobileAssembler.push(frame)) {
          if (event.kind === "message") {
            mobileMessageEmitter.fire(VSBuffer.wrap(jsonSafeToPortPayload(event.message)));
          }
        }
      }
      return true;
    },
  });

  const mobileProtocol: IMessagePassingProtocol = {
    send(buffer) {
      mobileSeq.value += 1;
      const frames = encodeWebRemoteControlRpcFrames(toJsonSafe(buffer.buffer), {
        streamId: "mobile-test",
        seq: mobileSeq.value,
      });
      for (const frame of frames) {
        for (const event of mobileToMainAssembler.push(frame)) {
          if (event.kind === "message") {
            pipe.acceptMobileMessage(jsonSafeToPortPayload(event.message));
          }
        }
      }
    },
    onMessage: mobileMessageEmitter.event,
  };

  const client = new ChannelClient(mobileProtocol);
  const channel = client.getChannel<IChannel>("test-channel");
  const service = ProxyChannel.toService<StubServiceShape>(channel);

  return {
    server,
    serverProtocol,
    client,
    pipe,
    service,
    stub,
    pingEmitter,
    pingSubscribed,
    logger,
    dispose() {
      server.dispose();
      serverProtocol.disconnect();
      client.dispose();
      pipe.dispose();
    },
  };
}

function createIdentityHarness(deferInit = false) {
  const bridgeSessionId = "bridge-current";
  const { a: serverPort, b: hostPort } = createFakePortPair();
  const posted = vi.spyOn(hostPort, "postMessage");
  const electronPort = {
    on(type: string, listener: PortListener | PortCloseListener) {
      if (type === "message") hostPort.on("message", listener as PortListener);
      else if (type === "close") hostPort.on("close", listener as PortCloseListener);
    },
    off(type: string, listener: PortListener | PortCloseListener) {
      if (type === "message") hostPort.off("message", listener as PortListener);
      else if (type === "close") hostPort.off("close", listener as PortCloseListener);
    },
    postMessage: (data: MessagePortPayload) => hostPort.postMessage(data),
    start: () => hostPort.start?.(),
    close: () => hostPort.close?.(),
  };
  const pingEmitter = new Emitter<string>();
  const unsubscribed = vi.fn();
  const subscribed = vi.fn();
  const echo = vi.fn(async (value: string) => `echo:${value}`);
  const serverProtocol = new MessagePortProtocol(serverPort);
  const server = new ChannelServer(serverProtocol, "identity-test", 1000, deferInit);
  server.registerChannel(
    "test-channel",
    ProxyChannel.fromService({
      echo,
      repeat: async (value: string) => value,
      onDidPing(listener: (value: string) => void) {
        subscribed();
        const subscription = pingEmitter.event(listener);
        return {
          dispose() {
            unsubscribed();
            subscription.dispose();
          },
        };
      },
    }),
  );
  const emitted: WebRemoteControlRpcTransportFrame[] = [];
  const assembler = new WebRemoteControlRpcAssembler({ streamId: bridgeSessionId });
  const messages = new Emitter<VSBuffer>();
  const onDegraded = vi.fn();
  const opened = openWebRemoteControlHostBridge({
    attachment: {
      attachmentId: "host-port-not-wire-identity",
      port: electronPort as unknown as import("electron").MessagePortMain,
      dispose: () => hostPort.close?.(),
    },
    bridgeSessionId,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    onDegraded,
    emitFrame({ frame }) {
      emitted.push(frame);
      if (frame.kind === "ack") return true;
      for (const event of assembler.push(frame)) {
        if (event.kind === "message") {
          messages.fire(VSBuffer.wrap(jsonSafeToPortPayload(event.message)));
        }
      }
      return true;
    },
  });
  let mobileSeq = 0;
  const client = new ChannelClient({
    onMessage: messages.event,
    send(buffer) {
      mobileSeq += 1;
      for (const frame of encodeWebRemoteControlRpcFrames(toJsonSafe(buffer.buffer), {
        streamId: bridgeSessionId,
        seq: mobileSeq,
      })) {
        opened.bridge.acceptFrame(frame);
      }
    },
  });
  const service = ProxyChannel.toService<StubServiceShape>(client.getChannel("test-channel"));
  return {
    bridgeSessionId,
    bridge: opened.bridge,
    emitted,
    posted,
    echo,
    subscribed,
    unsubscribed,
    pingEmitter,
    service,
    onDegraded,
    closeHostPort: () => serverPort.close(),
    dispose() {
      client.dispose();
      opened.dispose();
      server.dispose();
      serverProtocol.disconnect();
      messages.dispose();
      pingEmitter.dispose();
    },
  };
}

describe("hostBridge bridgeSessionId binding", () => {
  it("Host Initialize 前 attachment port 关闭时降级，dispose 自关闭不重复报告", async () => {
    const h = createIdentityHarness(true);
    const pendingRpc = h.service.echo("before-init");
    const pendingRpcRejected = expect(pendingRpc).rejects.toThrow("ChannelClient disposed");
    try {
      h.closeHostPort();
      await vi.waitFor(() => {
        expect(h.onDegraded).toHaveBeenCalledExactlyOnceWith("host-attachment-port-closed");
      });
      expect(h.echo).not.toHaveBeenCalled();
      for (const frame of encodeWebRemoteControlRpcFrames(toJsonSafe(new Uint8Array([1])), {
        streamId: h.bridgeSessionId,
        seq: 1,
      })) {
        h.bridge.acceptFrame(frame);
      }
      expect(h.posted).not.toHaveBeenCalled();
    } finally {
      h.dispose();
    }
    await pendingRpcRejected;
    expect(h.onDegraded).toHaveBeenCalledOnce();
  });

  it("dispose 移除 close listener，不把本地 port 关闭报告为 degraded", () => {
    const h = createIdentityHarness();
    h.dispose();
    expect(h.onDegraded).not.toHaveBeenCalled();
  });

  it("旧手机 message/分片/重传/ack/flow 不能进入新 Host，当前 Initialize/RPC/event lifecycle 正常", async () => {
    const h = createIdentityHarness();
    try {
      const stale = encodeWebRemoteControlRpcFrames(
        { stale: "x".repeat(1_100_000) },
        {
          streamId: "bridge-retired",
          seq: 1,
        },
      );
      expect(stale.length).toBeGreaterThan(1);
      for (const frame of [...stale, ...stale]) h.bridge.acceptFrame(frame);
      h.bridge.acceptFrame({ streamId: "bridge-retired", kind: "ack", seq: 10, ackSeq: 10 });
      h.bridge.acceptFrame({ streamId: "bridge-retired", kind: "flow", seq: 1, flow: "saturated" });
      expect(h.posted).not.toHaveBeenCalled();
      expect(h.onDegraded).not.toHaveBeenCalled();
      expect(await h.service.echo("new-host")).toBe("echo:new-host");
      expect(h.echo).toHaveBeenCalledExactlyOnceWith("new-host");
      expect(h.emitted.every((frame) => frame.streamId === h.bridgeSessionId)).toBe(true);
      const received: string[] = [];
      const subscription = h.service.onDidPing((value) => received.push(value));
      await vi.waitFor(() => expect(h.subscribed).toHaveBeenCalledOnce());
      h.pingEmitter.fire("current-event");
      await vi.waitFor(() => expect(received).toEqual(["current-event"]));
      subscription.dispose();
      await vi.waitFor(() => expect(h.unsubscribed).toHaveBeenCalledOnce());
      h.pingEmitter.fire("disposed-event");
      expect(received).toEqual(["current-event"]);
      expect(await h.service.repeat("x".repeat(900_000))).toHaveLength(900_000);
    } finally {
      h.dispose();
    }
  });

  it("同身份双向 ack 独立：旧 ack 不释放新 replay，当前 ack 只确认出站不推进入站", async () => {
    const h = createIdentityHarness();
    try {
      expect(await h.service.echo("one")).toBe("echo:one");
      await vi.waitFor(() => {
        expect(h.emitted.filter((frame) => frame.kind === "ack")).toContainEqual({
          streamId: h.bridgeSessionId,
          kind: "ack",
          seq: 1,
          ackSeq: 1,
        });
      });
      // Host 出站为 Initialize(seq=1)、reply(seq=2)，手机入站只有 request(seq=1)。
      h.bridge.acceptFrame({ streamId: "bridge-retired", kind: "ack", seq: 2, ackSeq: 2 });
      const gap = encodeWebRemoteControlRpcFrames({}, { streamId: h.bridgeSessionId, seq: 4 })[0]!;
      const start = h.emitted.length;
      h.bridge.acceptFrame(gap);
      expect(
        h.emitted
          .slice(start)
          .filter((frame) => frame.kind !== "ack")
          .map((frame) => frame.seq),
      ).toEqual([1, 2]);
      h.bridge.acceptFrame({ streamId: h.bridgeSessionId, kind: "ack", seq: 2, ackSeq: 2 });
      const afterAck = h.emitted.length;
      h.bridge.acceptFrame(gap);
      expect(h.emitted.slice(afterAck).filter((frame) => frame.kind !== "ack")).toEqual([]);
      // 若 ack=2 错误推进手机入站，合法 request(seq=2) 会被视为 stale、永远不 settle。
      expect(await h.service.echo("two")).toBe("echo:two");
    } finally {
      h.dispose();
    }
  });
});

describe("createWebRemoteControlServicePipe", () => {
  it("手机 ChannelClient 能穿过 pipe 收到 Host ChannelServer 的 Initialize", async () => {
    const harness = createHarness();
    const initialized = new Promise<void>((resolve) => {
      harness.client.onDidInitialize(() => resolve());
    });
    await initialized;
    harness.dispose();
  });

  it("手机调用 Host 服务：异步方法返回正确结果", async () => {
    const harness = createHarness();
    const result = await harness.service.echo("hello");
    expect(result).toBe("echo:hello");
    harness.dispose();
  });

  it("Host → 手机：服务端主动 push 一次事件", async () => {
    const harness = createHarness();
    const received: string[] = [];
    const disposable = harness.service.onDidPing((value) => received.push(value));
    // 先确保 EventListen 已到 Host（订阅已建立），再触发事件。
    await vi.waitFor(() => {
      expect(harness.pingSubscribed.value).toBe(true);
    });
    harness.pingEmitter.fire("ping-1");
    await vi.waitFor(() => {
      expect(received).toEqual(["ping-1"]);
    });
    disposable.dispose();
    harness.dispose();
  });

  it("大于单帧上限的载荷在分片/装配层往返后逐字节一致", async () => {
    const harness = createHarness();
    // 900KB 字符串 base64 后 > 1MB（maxFrameBytes），会触发多片往返。
    const large = "x".repeat(900_000);
    const result = await harness.service.repeat(large);
    expect(result).toBe(large);
    harness.dispose();
  });

  it("Host 消息落地失败时只 warn 一次（连续两条仍只一条）", async () => {
    const harness = createHarness();
    const failing = createWebRemoteControlServicePipe({
      hostPort: {
        addEventListener: (_type, listener) => {
          // 连续投递两条，但手机未挂载：只应留下首次 warn。
          listener({ data: new Uint8Array([1, 2, 3]) });
          listener({ data: new Uint8Array([4, 5, 6]) });
        },
        removeEventListener: () => {},
        postMessage: () => {},
        start: () => {},
        close: () => {},
      },
      sendToMobile: () => false,
      attachmentId: "attachment-drop",
      logger: harness.logger,
    });
    expect(harness.logger.warn).toHaveBeenCalledTimes(1);
    failing.dispose();
    harness.dispose();
  });
});
