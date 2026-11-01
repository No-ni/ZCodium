/**
 * IPCServer 连接 scope 所有权回归（纯内存 node:test，直接导入真实 TS 导出）。
 *
 * 规格依据 docs/specs/rpc-connection-ownership.md「IPCServer 公开框架连接 scope」：
 * - scope 从等待 ctx 起拥有每连接：先安装 disconnect，再等待第一条身份消息；
 * - 关闭不可逆且幂等：先摘除 owner 登记，再解绑本次注册的监听，释放已建通道资源，
 *   最后对已接纳连接通知一次 onDidRemoveConnection；等待握手中的 scope 关闭不产生 remove；
 * - 重复断开只 remove 一次；迟到身份帧与 add 回调重入关闭不能恢复连接；
 * - 多轮连接/断开后监听回到基线，不把每连接句柄永久留在全局 store；
 * - server dispose 终结握手中与活动 scope，但不 dispose 外部 IMessagePassingProtocol。
 *
 * 传输为 Emitter 直连的纯内存协议，用监听计数观察 scope 的注册与解除；
 * 不使用真实 socket，也不引入 Vitest（与既有 RPC Vitest 生命周期测试互补）。
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { VSBuffer } from "../src/buffer.js";
import { RequestType, type IServerChannel } from "../src/channels.shared.js";
import type { IMessagePassingProtocol } from "../src/protocol.js";
import { Emitter, toDisposable, type Event } from "../src/foundation.js";
import { BufferWriter, serialize } from "../src/serialization.js";
import { IPCClient, IPCServer, type ClientConnectionEvent } from "../src/ipc.js";

/** 包装事件统计存活监听数：scope 解除订阅后计数必须回到基线。 */
function countedEvent<T>(event: Event<T>): {
  event: Event<T>;
  liveCount(): number;
  subscriptionCount(): number;
} {
  let count = 0;
  let subscriptions = 0;
  return {
    event: (listener) => {
      count += 1;
      subscriptions += 1;
      const disposable = event(listener);
      return toDisposable(() => {
        count -= 1;
        disposable.dispose();
      });
    },
    liveCount: () => count,
    subscriptionCount: () => subscriptions,
  };
}

/** 排空微任务与一轮宏任务，保证 wire 往返与登记完成。 */
async function settle(): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

/** 构造一条合法的 Promise 请求帧（header + body），用于探测服务端通道是否存活。 */
function requestFrame(channelName: string, name: string, id: number): VSBuffer {
  const writer = new BufferWriter();
  serialize(writer, [RequestType.Promise, id, channelName, name]);
  serialize(writer, undefined);
  return writer.buffer;
}

function identityFrame(ctx: string): VSBuffer {
  const writer = new BufferWriter();
  serialize(writer, ctx);
  return writer.buffer;
}

/** 测试协议：在 IMessagePassingProtocol 之上附加 dispose spy，观察 scope 是否越界释放外部协议。 */
interface TestProtocol extends IMessagePassingProtocol {
  dispose(): void;
}

interface ConnectedClient {
  readonly ctx: string;
  // 连接事件先于 IPCClient 创建（scope 必须先订阅），因此握手后回填。
  client: IPCClient<string>;
  readonly live: { serverMessage: number; serverDisconnect: number };
  readonly protocolDisposed: { value: boolean };
  /** 服务端发往客户端的帧计数（S→C 响应观察）。 */
  readonly clientFrameCount: number;
  /** 触发服务端观察到的断开（可重复触发以验证幂等）。 */
  disconnect(): void;
  /** 直接向服务端投递原始帧（用于迟到身份帧或死通道探针）。 */
  sendToServer(buffer: VSBuffer): void;
  /** 本连接 disconnect 事件上的存活监听数（迟到句柄必须归零）。 */
  disconnectLive(): number;
  /** 累计服务端消息订阅次数，暴露终态后仍构造客户端的瞬时订阅。 */
  serverMessageSubscriptions(): number;
}

function createHarness() {
  const onDidClientConnect = new Emitter<ClientConnectionEvent>();
  const connectCounter = countedEvent(onDidClientConnect.event);
  const server = new IPCServer<string>(connectCounter.event);
  // 已注册 channel：活动连接上请求会立即得到响应，scope 关闭后则不再处理。
  server.registerChannel("probe", {
    call: async (_ctx, _command, arg) => arg,
    listen: () => () => ({ dispose() {} }),
  } as IServerChannel<string>);
  const addEvents: string[] = [];
  const removeEvents: string[] = [];
  server.onDidAddConnection((connection) => addEvents.push(connection.ctx));
  server.onDidRemoveConnection((connection) => removeEvents.push(connection.ctx));
  const disconnectByCtx = new Map<string, () => void>();

  function connect(
    ctx?: string,
    options?: { disconnectOnServerSend?: boolean; syncFireDisconnect?: boolean },
  ): ConnectedClient {
    const toServer = new Emitter<VSBuffer>();
    const toClient = new Emitter<VSBuffer>();
    const disconnectEmitter = new Emitter<void>();
    const serverMessage = countedEvent(toServer.event);
    const serverDisconnect = countedEvent(disconnectEmitter.event);
    let disconnectEvent: Event<void> = serverDisconnect.event;
    if (options?.syncFireDisconnect === true) {
      // 模拟订阅即同步触发的断开事件：scope 注册句柄前 close 已运行，迟到句柄必须立即释放。
      const syncFire: Event<void> = (listener) => {
        const disposable = serverDisconnect.event(listener);
        listener();
        return disposable;
      };
      disconnectEvent = syncFire;
    }
    const protocolDisposed = { value: false };
    let clientFrameCount = 0;
    toClient.event(() => {
      clientFrameCount += 1;
    });
    let sendDisconnects = options?.disconnectOnServerSend === true;
    const serverProtocol: TestProtocol = {
      onMessage: serverMessage.event,
      send: (buffer) => {
        toClient.fire(buffer);
        if (sendDisconnects) disconnectEmitter.fire();
      },
      dispose: () => {
        protocolDisposed.value = true;
      },
    };
    const connected: ConnectedClient = {
      ctx: ctx ?? "",
      // 未发 ctx 的场景不创建客户端，仅保留传输供迟到身份帧使用。
      client: undefined as unknown as IPCClient<string>,
      live: {
        get serverMessage() {
          return serverMessage.liveCount();
        },
        get serverDisconnect() {
          return serverDisconnect.liveCount();
        },
      },
      protocolDisposed,
      disconnect: () => disconnectEmitter.fire(),
      sendToServer: (buffer) => toServer.fire(buffer),
      /** 服务端发往客户端的帧计数（S→C 响应观察）。 */
      get clientFrameCount() {
        return clientFrameCount;
      },
      disconnectLive: () => serverDisconnect.liveCount(),
      serverMessageSubscriptions: () => serverMessage.subscriptionCount(),
    };
    disconnectByCtx.set(connected.ctx, connected.disconnect);
    // 先投递连接事件（scope 开始等待并安装监听），再创建 IPCClient 发送身份帧。
    onDidClientConnect.fire({
      protocol: serverProtocol,
      onDidClientDisconnect: disconnectEvent,
    });
    if (ctx !== undefined) {
      connected.client = new IPCClient<string>(
        { onMessage: toClient.event, send: (buffer) => toServer.fire(buffer) },
        ctx,
      );
    }
    return connected;
  }

  return {
    server,
    connect,
    addEvents,
    removeEvents,
    get connectListenerCount() {
      return connectCounter.liveCount();
    },
    triggerDisconnect(ctx: string) {
      disconnectByCtx.get(ctx)?.();
    },
  };
}

test(
  "ownership: disconnect before ctx leaves no ghost and ignores late identity frame",
  { timeout: 5000 },
  async () => {
    const harness = createHarness();
    const connection = harness.connect();
    connection.disconnect();
    await settle();
    // scope 关闭必须解除握手监听：旧实现在此留下悬挂的 ctx 订阅（ghost）。
    assert.equal(connection.live.serverMessage, 0);
    assert.equal(connection.live.serverDisconnect, 0);
    connection.sendToServer(identityFrame("late"));
    await settle();
    // 迟到身份帧不能恢复已终结的 scope。
    assert.deepEqual(harness.server.connections, []);
    assert.deepEqual(harness.addEvents, []);
    assert.deepEqual(harness.removeEvents, []);
    assert.equal(connection.protocolDisposed.value, false);
    harness.server.dispose();
  },
);

test(
  "ownership: re-entrant disconnect during add notification closes scope once",
  { timeout: 5000 },
  async () => {
    const harness = createHarness();
    const seen: string[] = [];
    // 模拟观察者在收到 add 通知时同步断开传输（add 回调重入关闭）。
    harness.server.onDidAddConnection((connection) => {
      seen.push(connection.ctx);
      harness.triggerDisconnect(connection.ctx);
    });
    const connection = harness.connect("worker");
    await settle();
    assert.deepEqual(seen, ["worker"]);
    assert.deepEqual(harness.addEvents, ["worker"]);
    assert.deepEqual(harness.removeEvents, ["worker"]);
    assert.deepEqual(harness.server.connections, []);
    assert.equal(connection.live.serverMessage, 0);
    assert.equal(connection.live.serverDisconnect, 0);
    // 通道资源已释放：向已注册 channel 发送合法请求帧也不再产生任何响应
    // （旧实现这里服务端通道仍存活；客户端侧调用受握手竞态影响不可靠，改用帧探针）。
    const framesBefore = connection.clientFrameCount;
    connection.sendToServer(requestFrame("probe", "work", 1));
    await settle();
    assert.equal(connection.clientFrameCount, framesBefore);
    harness.server.dispose();
    assert.deepEqual(harness.removeEvents, ["worker"]);
  },
);

test(
  "ownership: sync close during channel init send releases created resources",
  { timeout: 5000 },
  async () => {
    const harness = createHarness();
    // ChannelServer 构造的 Initialize 发送会同步触发断开（模拟传输在发送中判死）。
    const connection = harness.connect("worker", { disconnectOnServerSend: true });
    await settle();
    assert.deepEqual(harness.addEvents, []);
    assert.deepEqual(harness.removeEvents, []);
    assert.deepEqual(harness.server.connections, []);
    assert.equal(connection.live.serverMessage, 0);
    // 初始化已关闭时不应再构造 ChannelClient；最终归零不能掩盖额外的瞬时订阅。
    assert.equal(connection.serverMessageSubscriptions(), 2);
    assert.equal(connection.live.serverDisconnect, 0);
    harness.server.dispose();
  },
);

test(
  "ownership: repeated connect/disconnect rounds return listeners to baseline",
  { timeout: 5000 },
  async () => {
    const harness = createHarness();
    assert.equal(harness.connectListenerCount, 1);
    for (const ctx of ["a", "b", "c"]) {
      const connection = harness.connect(ctx);
      await settle();
      assert.deepEqual(
        harness.server.connections.map((entry) => entry.ctx),
        [ctx],
      );
      connection.disconnect();
      await settle();
      assert.deepEqual(harness.server.connections, []);
      // 每轮断开后监听归零：旧实现的 disconnect 句柄会永久留在全局 store。
      assert.equal(connection.live.serverMessage, 0);
      assert.equal(connection.live.serverDisconnect, 0);
    }
    assert.deepEqual(harness.addEvents, ["a", "b", "c"]);
    assert.deepEqual(harness.removeEvents, ["a", "b", "c"]);
    // 全局 store 只保留连接事件订阅本身，不随轮次积累。
    assert.equal(harness.connectListenerCount, 1);
    harness.server.dispose();
  },
);

test(
  "ownership: server dispose terminates waiting and active scopes without owning protocol",
  { timeout: 5000 },
  async () => {
    const harness = createHarness();
    const active = harness.connect("worker");
    const waiting = harness.connect();
    await settle();
    assert.deepEqual(
      harness.server.connections.map((entry) => entry.ctx),
      ["worker"],
    );
    harness.server.dispose();
    await settle();
    // 活动 scope：释放通道资源并通知一次 remove；等待 scope：直接终结不产生 remove。
    assert.deepEqual(harness.removeEvents, ["worker"]);
    assert.deepEqual(harness.addEvents, ["worker"]);
    assert.deepEqual(harness.server.connections, []);
    assert.equal(active.live.serverDisconnect, 0);
    assert.equal(waiting.live.serverMessage, 0);
    assert.equal(waiting.live.serverDisconnect, 0);
    assert.equal(active.protocolDisposed.value, false);
    assert.equal(waiting.protocolDisposed.value, false);
  },
);

test(
  "ownership: duplicate disconnect and late identity frame after close stay idempotent",
  { timeout: 5000 },
  async () => {
    const harness = createHarness();
    const connection = harness.connect("worker");
    await settle();
    connection.disconnect();
    connection.disconnect();
    await settle();
    // 重复断开只通知一次 remove。
    assert.deepEqual(harness.removeEvents, ["worker"]);
    connection.sendToServer(identityFrame("late"));
    await settle();
    assert.deepEqual(harness.server.connections, []);
    assert.deepEqual(harness.addEvents, ["worker"]);
    assert.deepEqual(harness.removeEvents, ["worker"]);
    harness.server.dispose();
    await settle();
    assert.deepEqual(harness.removeEvents, ["worker"]);
    assert.equal(connection.live.serverDisconnect, 0);
  },
);

test(
  "ownership: disconnect firing during subscribe leaves zero handles and no re-registered scope",
  { timeout: 5000 },
  async () => {
    const harness = createHarness();
    // 断开事件在 scope 订阅时同步触发：迟到句柄必须立即释放，已关 scope 不得重登记。
    const connection = harness.connect(undefined, { syncFireDisconnect: true });
    await settle();
    assert.equal(harness.server.connections.length, 0);
    assert.deepEqual(harness.addEvents, []);
    assert.deepEqual(harness.removeEvents, []);
    assert.equal(connection.live.serverMessage, 0);
    assert.equal(connection.disconnectLive(), 0);
    assert.equal(connection.protocolDisposed.value, false);
    // 可见连接为空还不够：closed scope 本身也必须从唯一 owner 集合摘除。
    assert.equal((harness.server as unknown as { scopes: Set<unknown> }).scopes.size, 0);
    // owner 集合回基线：后续正常连接/断开不受 ghost scope 影响。
    const normal = harness.connect("worker");
    await settle();
    assert.deepEqual(
      harness.server.connections.map((entry) => entry.ctx),
      ["worker"],
    );
    normal.disconnect();
    await settle();
    assert.deepEqual(harness.server.connections, []);
    assert.equal(normal.live.serverDisconnect, 0);
    harness.server.dispose();
  },
);

test(
  "ownership: connect callback after same-fire dispose does not resurrect the server",
  { timeout: 5000 },
  async () => {
    const onDidClientConnect = new Emitter<ClientConnectionEvent>();
    const toServer = new Emitter<VSBuffer>();
    const toClient = new Emitter<VSBuffer>();
    const disconnectEmitter = new Emitter<void>();
    const serverMessage = countedEvent(toServer.event);
    const serverDisconnect = countedEvent(disconnectEmitter.event);
    const addEvents: string[] = [];
    const removeEvents: string[] = [];
    // 前置监听先于 server 订阅注册：同一次 fire 内它先 dispose server，
    // Emitter.fire 的快照仍会把本连接投递给已 dispose 的 server 回调。
    let server: IPCServer<string> | undefined;
    onDidClientConnect.event(() => {
      server?.dispose();
    });
    server = new IPCServer<string>(onDidClientConnect.event);
    server.onDidAddConnection((connection) => addEvents.push(connection.ctx));
    server.onDidRemoveConnection((connection) => removeEvents.push(connection.ctx));
    onDidClientConnect.fire({
      protocol: { onMessage: serverMessage.event, send: (buffer) => toClient.fire(buffer) },
      onDidClientDisconnect: serverDisconnect.event,
    });
    await settle();
    // disposed server 不得复活：不登记 scope，也不在协议上留下任何订阅。
    assert.deepEqual(addEvents, []);
    assert.deepEqual(removeEvents, []);
    assert.equal(serverMessage.liveCount(), 0);
    assert.equal(serverDisconnect.liveCount(), 0);
    server.dispose();
    await settle();
    assert.equal(serverMessage.liveCount(), 0);
    assert.equal(serverDisconnect.liveCount(), 0);
  },
);
