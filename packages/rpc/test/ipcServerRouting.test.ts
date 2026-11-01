/**
 * IPCServer 未路由调用路由等待回归（纯内存 node:test，直接导入真实 TS 导出）。
 *
 * 规格依据 docs/specs/rpc-client-lifecycle.md「IPCServer 未路由调用的所有权」：
 * - IPCServer 是未路由调用的唯一 owner；等待项统一 finish：先移除登记并解除
 *   本地新增连接及取消监听，再拒绝或移交调用；
 * - 路由阶段持有独立 CancellationTokenSource：用户取消联动，server dispose 主动 cancel，
 *   正常选中只 dispose 不 cancel；
 * - IClientRouter.routeCall 以既有可选 cancellationToken 接收阶段 token；StaticRouter
 *   在取消时解除自己的新增连接等待；ChannelClient 始终收到原用户 token；
 * - 路由结果只可选择当前活跃连接；终结后的结果与匹配不得发送请求；
 * - 自定义 router 忽略阶段 token 时 RPC 仍及时拒绝并丢弃迟到结果；
 * - 不使用 timeout 或残留监听的 Promise.race。
 *
 * 纯内存传输 + 真实 IPCServer/IPCClient/StaticRouter；不引入 Vitest。
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { VSBuffer } from "../src/buffer.js";
import type { IServerChannel } from "../src/channels.shared.js";
import type { IMessagePassingProtocol } from "../src/protocol.js";
import {
  CancellationTokenSource,
  Emitter,
  toDisposable,
  type CancellationToken,
  type Event,
} from "../src/foundation.js";
import {
  IPCClient,
  IPCServer,
  StaticRouter,
  type Client,
  type ClientConnectionEvent,
  type IClientRouter,
  type IConnectionHub,
} from "../src/ipc.js";

/** 包装事件统计存活监听数：等待终结后计数必须归零。 */
function countedEvent<T>(event: Event<T>): { event: Event<T>; liveCount(): number } {
  let count = 0;
  return {
    event: (listener) => {
      count += 1;
      const disposable = event(listener);
      return toDisposable(() => {
        count -= 1;
        disposable.dispose();
      });
    },
    liveCount: () => count,
  };
}

/** 排空微任务与一轮宏任务，保证 wire 往返与登记完成。 */
async function settle(): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

interface BusinessLog {
  calls: { command: string; arg: unknown }[];
  cancelled: number;
}

/** 客户端业务 channel：echo 原样返回，hang 挂起以观察取消传播。 */
function createBusinessChannel(log: BusinessLog): IServerChannel<string> {
  return {
    call: async (_ctx, command, arg, token) => {
      log.calls.push({ command, arg });
      if (command === "hang") {
        if (token)
          token.onCancellationRequested(() => {
            log.cancelled += 1;
          });
        return new Promise(() => {});
      }
      return arg;
    },
    listen: () => () => ({ dispose() {} }),
  };
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
  disconnect(): void;
}

function createRoutingHarness() {
  const onDidClientConnect = new Emitter<ClientConnectionEvent>();
  const server = new IPCServer<string>(onDidClientConnect.event);
  const addEvents: string[] = [];
  const removeEvents: string[] = [];
  server.onDidAddConnection((connection) => addEvents.push(connection.ctx));
  server.onDidRemoveConnection((connection) => removeEvents.push(connection.ctx));
  const log: BusinessLog = { calls: [], cancelled: 0 };

  function connectTransport(ctx?: string): ConnectedClient {
    const toServer = new Emitter<VSBuffer>();
    const toClient = new Emitter<VSBuffer>();
    const disconnectEmitter = new Emitter<void>();
    const serverMessage = countedEvent(toServer.event);
    const serverDisconnect = countedEvent(disconnectEmitter.event);
    const protocolDisposed = { value: false };
    const serverProtocol: TestProtocol = {
      onMessage: serverMessage.event,
      send: (buffer) => toClient.fire(buffer),
      dispose: () => {
        protocolDisposed.value = true;
      },
    };
    const connected: ConnectedClient = {
      ctx: ctx ?? "",
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
    };
    onDidClientConnect.fire({
      protocol: serverProtocol,
      onDidClientDisconnect: serverDisconnect.event,
    });
    if (ctx !== undefined) {
      const client = new IPCClient<string>(
        { onMessage: toClient.event, send: (buffer) => toServer.fire(buffer) },
        ctx,
      );
      connected.client = client;
      client.registerChannel("test", createBusinessChannel(log));
    }
    return connected;
  }

  return {
    server,
    log,
    addEvents,
    removeEvents,
    connectClient(ctx: string): ConnectedClient {
      return connectTransport(ctx);
    },
  };
}

test(
  "routing: pre-cancelled filter call rejects without registering waiters",
  { timeout: 5000 },
  async () => {
    const harness = createRoutingHarness();
    const source = new CancellationTokenSource();
    source.cancel();
    await assert.rejects(
      harness.server.getChannel("test", () => false).call("echo", "ping", source.token),
      /Cancelled/,
    );
    // 预取消不得登记任何等待监听：后续匹配连接出现也不产生请求。
    harness.connectClient("worker");
    await settle();
    assert.deepEqual(harness.log.calls, []);
    harness.server.dispose();
  },
);

test(
  "routing: user cancellation settles waiting filter call and drops late match",
  { timeout: 5000 },
  async () => {
    const harness = createRoutingHarness();
    const source = new CancellationTokenSource();
    const pending = harness.server
      .getChannel("test", (client) => client.ctx === "worker")
      .call("echo", "ping", source.token);
    const assertion = assert.rejects(pending, /Cancelled/);
    await settle();
    source.cancel();
    await assertion;
    // 取消后到达的匹配连接不再触发移交，也不发送请求。
    const late = harness.connectClient("worker");
    await settle();
    assert.deepEqual(harness.log.calls, []);
    assert.equal(late.live.serverDisconnect, 1);
    harness.server.dispose();
  },
);

test(
  "routing: server dispose settles waiting filter call with disposed error",
  { timeout: 5000 },
  async () => {
    const harness = createRoutingHarness();
    const pending = harness.server.getChannel("test", () => false).call("echo", "ping");
    const assertion = assert.rejects(pending, /IPCServer is disposed/);
    await settle();
    harness.server.dispose();
    await assertion;
    assert.deepEqual(harness.log.calls, []);
    harness.server.dispose();
  },
);

test(
  "routing: late matching connection hands off and completes with original token",
  { timeout: 5000 },
  async () => {
    const harness = createRoutingHarness();
    const source = new CancellationTokenSource();
    let userTokenFired = 0;
    source.token.onCancellationRequested(() => {
      userTokenFired += 1;
    });
    const pending = harness.server
      .getChannel("test", (client) => client.ctx === "worker")
      .call("echo", "ping", source.token);
    await settle();
    harness.connectClient("worker");
    assert.equal(await pending, "ping");
    assert.deepEqual(harness.log.calls, [{ command: "echo", arg: "ping" }]);
    // 原用户 token 全程未被取消。
    assert.equal(userTokenFired, 0);
    assert.equal(source.token.isCancellationRequested, false);
    harness.server.dispose();
  },
);

test(
  "routing: cancellation after handoff reaches the business token through ChannelClient",
  { timeout: 5000 },
  async () => {
    const harness = createRoutingHarness();
    const source = new CancellationTokenSource();
    harness.connectClient("worker");
    const pending = harness.server
      .getChannel("test", (client) => client.ctx === "worker")
      .call("hang", undefined, source.token);
    const assertion = assert.rejects(pending, /Cancelled/);
    await settle();
    assert.equal(harness.log.calls.length, 1);
    source.cancel();
    await assertion;
    await settle();
    // 移交后取消仍有效：原 token 经 ChannelClient 传播到业务取消令牌。
    assert.equal(harness.log.cancelled, 1);
    harness.server.dispose();
  },
);

test(
  "routing: successful handoff disposes stage source without cancelling tokens",
  { timeout: 5000 },
  async () => {
    const harness = createRoutingHarness();
    const source = new CancellationTokenSource();
    let userTokenFired = 0;
    source.token.onCancellationRequested(() => {
      userTokenFired += 1;
    });
    const stageTokens: CancellationToken[] = [];
    // 记录 router 收到的阶段 token：正常选中只 dispose 阶段源，不 cancel。
    const delegatingRouter: IClientRouter<string> = {
      routeCall: (hub, command, arg, token) => {
        stageTokens.push(token as CancellationToken);
        return new StaticRouter<string>((ctx) => ctx === "worker").routeCall(
          hub,
          command,
          arg,
          token,
        );
      },
      routeEvent: (hub, _event, _arg) =>
        new StaticRouter<string>((ctx) => ctx === "worker").routeEvent(hub),
    };
    harness.connectClient("worker");
    assert.equal(
      await harness.server.getChannel("test", delegatingRouter).call("echo", "ping", source.token),
      "ping",
    );
    assert.equal(stageTokens.length, 1);
    // 阶段 token 是独立取消源，不等于用户 token；正常选中未取消。
    assert.notEqual(stageTokens[0], source.token);
    assert.equal(stageTokens[0]?.isCancellationRequested, false);
    assert.equal(userTokenFired, 0);
    harness.server.dispose();
  },
);

test(
  "routing: StaticRouter unblocks and cleans its add-connection wait on cancel",
  { timeout: 5000 },
  async () => {
    type HubConnection = IConnectionHub<string>["connections"][number];
    const addEmitter = new Emitter<HubConnection>();
    const countedAdd = countedEvent(addEmitter.event);
    const hub: IConnectionHub<string> = {
      connections: [],
      onDidAddConnection: countedAdd.event,
      onDidRemoveConnection: () => ({ dispose() {} }),
    };
    const router = new StaticRouter<string>((ctx) => ctx === "worker");
    const source = new CancellationTokenSource();
    const routed = router.routeCall(hub, "cmd", undefined, source.token);
    const assertion = assert.rejects(routed, /Cancelled/);
    await settle();
    assert.equal(countedAdd.liveCount(), 1);
    source.cancel();
    await assertion;
    // 取消后 StaticRouter 的新增连接监听必须归零。
    assert.equal(countedAdd.liveCount(), 0);
  },
);

test("routing: server dispose settles pending StaticRouter wait", { timeout: 5000 }, async () => {
  const harness = createRoutingHarness();
  const router = new StaticRouter<string>((ctx) => ctx === "worker");
  const pending = harness.server.getChannel("test", router).call("echo", "ping");
  const assertion = assert.rejects(pending, /IPCServer is disposed/);
  await settle();
  harness.server.dispose();
  await assertion;
  assert.deepEqual(harness.log.calls, []);
  assert.deepEqual(harness.addEvents, []);
  harness.server.dispose();
});

test(
  "routing: user cancel settles wait promptly even when custom router ignores stage token",
  { timeout: 5000 },
  async () => {
    const harness = createRoutingHarness();
    const connection = harness.connectClient("worker");
    const active: Client<string> = harness.server.connections[0];
    let resolveRouter: ((client: Client<string>) => void) | undefined;
    let rejectRouter: ((error: Error) => void) | undefined;
    // 完全忽略阶段 token 的自定义 router：RPC 仍需及时拒绝并丢弃迟到结果。
    const ignoringRouter: IClientRouter<string> = {
      routeCall: () =>
        new Promise<Client<string>>((resolve, reject) => {
          resolveRouter = resolve;
          rejectRouter = reject;
        }),
      routeEvent: () => Promise.reject(new Error("not used")),
    };
    const source = new CancellationTokenSource();
    const pending = harness.server
      .getChannel("test", ignoringRouter)
      .call("echo", "ping", source.token);
    const assertion = assert.rejects(pending, /Cancelled/);
    await settle();
    assert.deepEqual(harness.log.calls, []);
    source.cancel();
    await assertion;
    // 迟到 resolve 被丢弃：不向任何连接发送请求。
    resolveRouter?.(active);
    await settle();
    assert.deepEqual(harness.log.calls, []);
    // 迟到 reject 也不得成为未处理拒绝（否则本测试进程会失败）。
    rejectRouter?.(new Error("late router rejection"));
    await settle();
    assert.deepEqual(harness.log.calls, []);
    assert.equal(connection.live.serverDisconnect, 1);
    harness.server.dispose();
  },
);

test(
  "routing: routed result for terminated connection is rejected without sending",
  { timeout: 5000 },
  async () => {
    const harness = createRoutingHarness();
    const connection = harness.connectClient("worker");
    const active: Client<string> = harness.server.connections[0];
    let resolveRouter: ((client: Client<string>) => void) | undefined;
    const staleRouter: IClientRouter<string> = {
      routeCall: () =>
        new Promise<Client<string>>((resolve) => {
          resolveRouter = resolve;
        }),
      routeEvent: () => Promise.reject(new Error("not used")),
    };
    const pending = harness.server.getChannel("test", staleRouter).call("echo", "ping");
    const assertion = assert.rejects(pending, /no longer active/);
    await settle();
    connection.disconnect();
    await settle();
    // 连接终结后给出的路由结果必须被拒绝，且不得发送请求。
    resolveRouter?.(active);
    await assertion;
    assert.deepEqual(harness.log.calls, []);
    harness.server.dispose();
  },
);

/** 订阅即同步触发取消的外部 token：观察迟到句柄是否被立即释放。 */
function createSyncCancelToken(): { token: CancellationToken; disposed(): number } {
  let disposeCount = 0;
  const token: CancellationToken = {
    isCancellationRequested: false,
    onCancellationRequested: (listener) => {
      listener();
      return {
        dispose: () => {
          disposeCount += 1;
        },
      };
    },
  };
  return { token, disposed: () => disposeCount };
}

/** 取消联动句柄在释放时抛错的外部 token：终态清理不得被单个 disposer 阻断。 */
function createThrowingDisposerToken(): { token: CancellationToken; fireCancel(): void } {
  let fire: (() => void) | undefined;
  const token: CancellationToken = {
    isCancellationRequested: false,
    onCancellationRequested: (listener) => {
      fire = listener;
      return {
        dispose: () => {
          throw new Error("external disposer failure");
        },
      };
    },
  };
  return { token, fireCancel: () => fire?.() };
}

test(
  "routing: router may return a bare Client and the active connection is selected by ctx",
  { timeout: 5000 },
  async () => {
    const harness = createRoutingHarness();
    harness.connectClient("worker");
    // 公开契约：routeCall 只承诺返回 Client（ctx）；IPCServer 按 ctx 选中当前活跃连接。
    const bareClientRouter: IClientRouter<string> = {
      routeCall: () => Promise.resolve({ ctx: "worker" }),
      routeEvent: () => Promise.reject(new Error("not used")),
    };
    assert.equal(
      await harness.server.getChannel("test", bareClientRouter).call("echo", "ping"),
      "ping",
    );
    assert.deepEqual(harness.log.calls, [{ command: "echo", arg: "ping" }]);
    harness.server.dispose();
  },
);

test(
  "routing: token cancelling during subscribe leaves no late handle on the finished wait",
  { timeout: 5000 },
  async () => {
    const harness = createRoutingHarness();
    const { token, disposed } = createSyncCancelToken();
    await assert.rejects(
      harness.server.getChannel("test", () => false).call("echo", "ping", token),
      /Cancelled/,
    );
    // 迟到返回的联动句柄必须立即释放：等待已终结，不得把句柄留在已终结等待里。
    assert.equal(disposed(), 1);
    harness.server.dispose();
  },
);

test(
  "routing: throwing external disposer cannot block settle or leave the add waiter",
  { timeout: 5000 },
  async () => {
    const harness = createRoutingHarness();
    const { token, fireCancel } = createThrowingDisposerToken();
    const pending = harness.server
      .getChannel("test", (client) => client.ctx === "worker")
      .call("echo", "ping", token);
    const assertion = assert.rejects(pending, /Cancelled/);
    await settle();
    // 取消触发 finish：单个 throwing disposer 不得阻断 settle 与其余监听清理。
    fireCancel();
    await assertion;
    // add 等待监听必须已释放：后续匹配连接不得再触发移交或请求。
    harness.connectClient("worker");
    await settle();
    assert.deepEqual(harness.log.calls, []);
    harness.server.dispose();
  },
);

test(
  "routing: server dispose survives a throwing wait disposer and closes remaining scopes",
  { timeout: 5000 },
  async () => {
    const harness = createRoutingHarness();
    harness.connectClient("worker");
    const { token } = createThrowingDisposerToken();
    const ignoringRouter: IClientRouter<string> = {
      routeCall: () => new Promise<Client<string>>(() => {}),
      routeEvent: () => Promise.reject(new Error("not used")),
    };
    const pending = harness.server.getChannel("test", ignoringRouter).call("echo", "ping", token);
    const assertion = assert.rejects(pending, /IPCServer is disposed/);
    await settle();
    // wait 的外部 disposer 抛错不得阻断 server dispose 关闭其余等待与活动 scope。
    harness.server.dispose();
    await assertion;
    assert.deepEqual(harness.removeEvents, ["worker"]);
    assert.deepEqual(harness.server.connections, []);
  },
);

test(
  "routing: throwing filter predicate fails the wait without leaking into add notification",
  { timeout: 5000 },
  async () => {
    const harness = createRoutingHarness();
    // 初始无连接：谓词只会在新增连接投递时抛错。
    const pending = harness.server
      .getChannel("test", () => {
        throw new Error("predicate boom");
      })
      .call("echo", "ping");
    const assertion = assert.rejects(pending, /predicate boom/);
    // 谓词抛错按路由失败终结：连接本身必须照常被接纳（异常不向 add 事件链泄漏）。
    harness.connectClient("worker");
    await assertion;
    await settle();
    assert.deepEqual(harness.addEvents, ["worker"]);
    assert.deepEqual(
      harness.server.connections.map((entry) => entry.ctx),
      ["worker"],
    );
    assert.deepEqual(harness.log.calls, []);
    harness.server.dispose();
  },
);

test(
  "routing: terminal wait discards late router result without touching it",
  { timeout: 5000 },
  async () => {
    const harness = createRoutingHarness();
    harness.connectClient("worker");
    let ctxReads = 0;
    let resolveRouter: ((client: Client<string>) => void) | undefined;
    const lateResultRouter: IClientRouter<string> = {
      routeCall: () =>
        new Promise<Client<string>>((resolve) => {
          resolveRouter = resolve;
        }),
      routeEvent: () => Promise.reject(new Error("not used")),
    };
    const source = new CancellationTokenSource();
    const pending = harness.server
      .getChannel("test", lateResultRouter)
      .call("echo", "ping", source.token);
    const assertion = assert.rejects(pending, /Cancelled/);
    await settle();
    source.cancel();
    await assertion;
    // 终结后的迟到结果必须整体丢弃：先于读取其 ctx / 求活跃列表直接返回。
    resolveRouter?.({
      get ctx() {
        ctxReads += 1;
        return "worker";
      },
    });
    await settle();
    assert.equal(ctxReads, 0);
    assert.deepEqual(harness.log.calls, []);
    harness.server.dispose();
  },
);

test(
  "routing: explicit active connection keeps its selection among equal contexts",
  { timeout: 5000 },
  async (t) => {
    const harness = createRoutingHarness();
    const first = harness.connectClient("worker");
    const second = harness.connectClient("worker");
    t.after(() => {
      harness.server.dispose();
      first.client.dispose();
      second.client.dispose();
    });
    // 记录接收端并原样回传参数，避免把固定 string 冒充任意泛型回包。
    const selectedCalls: string[] = [];
    first.client.registerChannel("pick", {
      call: async (_ctx, _command, arg) => {
        selectedCalls.push("first");
        return arg;
      },
      listen: () => () => ({ dispose() {} }),
    });
    second.client.registerChannel("pick", {
      call: async (_ctx, _command, arg) => {
        selectedCalls.push("second");
        return arg;
      },
      listen: () => () => ({ dispose() {} }),
    });
    const selected = harness.server.connections[1];
    assert.ok(selected);
    const router: IClientRouter<string> = {
      routeCall: () => Promise.resolve(selected),
      routeEvent: () => Promise.reject(new Error("not used")),
    };
    assert.equal(
      await harness.server.getChannel("pick", router).call("echo", "echo marker"),
      "echo marker",
    );
    assert.deepEqual(selectedCalls, ["second"]);
  },
);

test(
  "routing: inactive explicit connection cannot select a replacement with equal context",
  { timeout: 5000 },
  async (t) => {
    const harness = createRoutingHarness();
    const first = harness.connectClient("worker");
    const selected = harness.server.connections[0];
    assert.ok(selected);
    first.disconnect();
    const replacement = harness.connectClient("worker");
    t.after(() => {
      harness.server.dispose();
      first.client.dispose();
      replacement.client.dispose();
    });
    const router: IClientRouter<string> = {
      routeCall: () => Promise.resolve(selected),
      routeEvent: () => Promise.reject(new Error("not used")),
    };
    await assert.rejects(
      harness.server.getChannel("test", router).call("echo", "old"),
      /no longer active/,
    );
    assert.deepEqual(harness.log.calls, []);
  },
);

test(
  "routing: StaticRouter releases a late handle after synchronous hub notification",
  { timeout: 5000 },
  async (t) => {
    const harness = createRoutingHarness();
    const connected = harness.connectClient("worker");
    const source = new CancellationTokenSource();
    t.after(() => {
      harness.server.dispose();
      connected.client.dispose();
      source.dispose();
    });
    const connection = harness.server.connections[0];
    assert.ok(connection);
    const connections: IConnectionHub<string>["connections"][number][] = [];
    let addedDisposed = 0;
    let cancelSubscriptions = 0;
    const hub: IConnectionHub<string> = {
      connections,
      onDidAddConnection: (listener) => {
        connections.push(connection);
        listener(connection);
        return toDisposable(() => {
          addedDisposed += 1;
        });
      },
      onDidRemoveConnection: () => toDisposable(() => {}),
    };
    const token: CancellationToken = {
      get isCancellationRequested() {
        return source.token.isCancellationRequested;
      },
      onCancellationRequested: (listener) => {
        cancelSubscriptions += 1;
        return source.token.onCancellationRequested(listener);
      },
    };
    const router = new StaticRouter<string>((ctx) => ctx === "worker");
    assert.equal(await router.routeCall(hub, "echo", undefined, token), connection);
    assert.equal(addedDisposed, 1);
    assert.equal(cancelSubscriptions, 0);
  },
);

test("routing: StaticRouter releases a late cancellation handle", { timeout: 5000 }, async (t) => {
  const addedEmitter = new Emitter<IConnectionHub<string>["connections"][number]>();
  const added = countedEvent(addedEmitter.event);
  t.after(() => addedEmitter.dispose());
  const hub: IConnectionHub<string> = {
    connections: [],
    onDidAddConnection: added.event,
    onDidRemoveConnection: () => toDisposable(() => {}),
  };
  const { token, disposed } = createSyncCancelToken();
  const router = new StaticRouter<string>((ctx) => ctx === "worker");
  await assert.rejects(router.routeCall(hub, "echo", undefined, token), /Cancelled/);
  assert.equal(added.liveCount(), 0);
  assert.equal(disposed(), 1);
});

test(
  "routing: throwing stage cancellation cannot stop other waits and scopes",
  { timeout: 5000 },
  async (t) => {
    const harness = createRoutingHarness();
    const connected = harness.connectClient("worker");
    t.after(() => {
      harness.server.dispose();
      connected.client.dispose();
    });
    const router: IClientRouter<string> = {
      routeCall: (_hub, _command, _arg, token) => {
        assert.ok(token);
        token.onCancellationRequested(() => {
          throw new Error("external cancellation failure");
        });
        return new Promise<Client<string>>(() => {});
      },
      routeEvent: () => Promise.reject(new Error("not used")),
    };
    const first = assert.rejects(
      harness.server.getChannel("test", router).call("echo"),
      /IPCServer is disposed/,
    );
    const second = assert.rejects(
      harness.server.getChannel("test", () => false).call("echo"),
      /IPCServer is disposed/,
    );
    await settle();
    assert.doesNotThrow(() => harness.server.dispose());
    await Promise.all([first, second]);
    assert.deepEqual(harness.removeEvents, ["worker"]);
    assert.deepEqual(harness.server.connections, []);
  },
);

test(
  "routing: cancel in the first active filter candidate stops later predicates",
  { timeout: 5000 },
  async () => {
    const harness = createRoutingHarness();
    const first = harness.connectClient("first");
    const second = harness.connectClient("second");
    const source = new CancellationTokenSource();
    const visited: string[] = [];
    try {
      await settle();
      const channel = harness.server.getChannel("test", (client: Client<string>) => {
        visited.push(client.ctx);
        source.cancel();
        return false;
      });
      await assert.rejects(channel.call("echo", "must-not-dispatch", source.token), /Cancelled/);
      // find 不能只在整个遍历后查终态，否则取消后仍会执行下一条外部谓词。
      assert.deepEqual(visited, ["first"]);
      assert.equal(harness.log.calls.length, 0);
    } finally {
      source.dispose();
      first.client.dispose();
      second.client.dispose();
      harness.server.dispose();
    }
  },
);

test(
  "routing: cancelling ctx getter is read once and never revisited for another candidate",
  { timeout: 5000 },
  async () => {
    const harness = createRoutingHarness();
    const first = harness.connectClient("first");
    const second = harness.connectClient("second");
    const source = new CancellationTokenSource();
    let reads = 0;
    const selected: Client<string> = {
      get ctx() {
        reads += 1;
        source.cancel();
        return "second";
      },
    };
    const router: IClientRouter<string> = {
      routeCall: async () => selected,
      routeEvent: async () => ({ ctx: "second" }),
    };
    try {
      await settle();
      const channel = harness.server.getChannel("test", router);
      await assert.rejects(channel.call("echo", "must-not-dispatch", source.token), /Cancelled/);
      // 第一条候选不匹配时，getter 已取消；不能在下一候选上再次读取标识。
      assert.equal(reads, 1);
      assert.equal(harness.log.calls.length, 0);
    } finally {
      source.dispose();
      first.client.dispose();
      second.client.dispose();
      harness.server.dispose();
    }
  },
);
