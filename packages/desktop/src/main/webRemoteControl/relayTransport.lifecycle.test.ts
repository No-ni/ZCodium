import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRelayDeviceTransport } from "./relayTransport.js";

vi.mock("ws", () => ({
  get WebSocket() {
    return FakeSocket;
  },
}));
class FakeSocket extends EventEmitter {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  constructor(
    _url: string,
    readonly options: { maxPayload?: number },
  ) {
    super();
    FakeSocket.instances.push(this);
  }
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  open() {
    this.readyState = 1;
    this.emit("open");
  }
  receive(frame: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(frame)));
  }
  close(code = 1000) {
    this.readyState = 3;
    this.emit("close", code);
  }
}

let transport: ReturnType<typeof createRelayDeviceTransport>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  FakeSocket.instances = [];
});
afterEach(() => {
  transport?.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function createTransport() {
  transport = createRelayDeviceTransport({
    logger: { info() {}, warn() {}, error() {} },
    relayWsUrl: "ws://localhost/ws",
    deviceMid: "test-mid",
    deviceName: "test",
    appVersion: "test",
    maxPhysicalFrameBytes: 1024,
    auth: { mode: "persisted", deviceSid: "test-sid", passHash: "test-hash" },
    events: {
      onStateChange() {},
      onPayload() {},
      onRegisteredAuth() {},
      onError() {},
      async onInvalidPersistedAuth() {},
    },
  });
  return transport;
}

describe("relay connection generations", () => {
  it.each(["error-frame", "close-code"])("被踢后停止重连并忽略迟到 ACK：%s", async (kind) => {
    const start = createTransport().start();
    const socket = FakeSocket.instances[0]!;
    socket.open();
    socket.receive({ type: "auth_ack", pair_status: "matched" });
    await vi.advanceTimersByTimeAsync(50);
    await start;
    if (kind === "error-frame") socket.receive({ type: "error", code: "KICKED" });
    else socket.close(4002);
    socket.receive({ type: "auth_ack", pair_status: "matched" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(socket.sent.some((frame) => frame.type === "pair_status_query")).toBe(false);
    expect(
      transport.sendPayload({ zcode_type: "bootstrap-request", requestId: "terminated" }),
    ).toBe(false);
  });

  it("旧 challenge 异步完成后不得将 proof 发给替换连接", async () => {
    const start = createTransport().start();
    const first = FakeSocket.instances[0]!;
    first.open();
    first.receive({ type: "auth_challenge", nonce: "old-nonce" });
    first.close();
    vi.advanceTimersByTime(1000);
    const second = FakeSocket.instances[1]!;
    second.open();
    // allow dynamic crypto import in the original implementation to settle after replacement
    await vi.advanceTimersByTimeAsync(50);
    second.receive({ type: "auth_ack", pair_status: "waiting" });
    await vi.advanceTimersByTimeAsync(50);
    await start;
    expect(second.sent.some((frame) => frame.type === "auth_response")).toBe(false);
  });

  it("成功鉴权后的下一次断线重新从基础退避开始", async () => {
    const start = createTransport().start();
    FakeSocket.instances[0]!.close();
    vi.advanceTimersByTime(1000);
    const second = FakeSocket.instances[1]!;
    second.open();
    second.receive({ type: "auth_ack", pair_status: "waiting" });
    await vi.advanceTimersByTimeAsync(50);
    await start;
    second.close();
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.instances).toHaveLength(3);
    expect(FakeSocket.instances[2]!.options.maxPayload).toBe(1024);
  });
});
