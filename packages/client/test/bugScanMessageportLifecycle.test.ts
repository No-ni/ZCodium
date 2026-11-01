import assert from "node:assert/strict";
import test from "node:test";
import { ChannelServer, Emitter, MessagePortProtocol, ProxyChannel } from "@zcode/rpc";
import { ISourceServerManagementService } from "@zcode/services";
import type { IChannelClient } from "@zcode/rpc";
import { connectViaMessagePort, createMessagePortServiceConnection } from "../src/messageport.js";
import { RemoteServiceAccess } from "../src/remoteServiceAccess.js";

type PortListener = (e: { data: unknown }) => void;

// mock MessagePort 对：微任务投递保持顺序，提供 start/close 计数供 dispose 断言。
class FakeMessagePort {
  peer: FakeMessagePort | undefined;
  closed = false;
  closeCalls = 0;
  private listeners = new Set<PortListener>();
  addEventListener(_type: "message", listener: PortListener): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: "message", listener: PortListener): void {
    this.listeners.delete(listener);
  }
  postMessage(message: unknown): void {
    const peer = this.peer;
    if (!peer || peer.closed) return;
    queueMicrotask(() => {
      // 投递期间可能有监听器同步退订，快照集合避免迭代被修改打断。
      // oxlint-disable-next-line unicorn/no-useless-spread
      if (!peer.closed) for (const listener of [...peer.listeners]) listener({ data: message });
    });
  }
  start(): void {}
  close(): void {
    this.closeCalls++;
    this.closed = true;
    this.listeners.clear();
  }
}

function createPortPair(): { client: FakeMessagePort; server: FakeMessagePort } {
  const client = new FakeMessagePort();
  const server = new FakeMessagePort();
  client.peer = server;
  server.peer = client;
  return { client, server };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

interface HarnessFixture {
  clientPort: FakeMessagePort;
  serverPort: FakeMessagePort;
  services: ReturnType<typeof createMessagePortServiceConnection>["services"];
  connection: ReturnType<typeof createMessagePortServiceConnection>;
  tick: Emitter<string>;
  releaseHang: (value: string) => void;
  server: ChannelServer;
}

async function createHarness(withServer = true): Promise<HarnessFixture> {
  const { client, server } = createPortPair();
  const tick = new Emitter<string>();
  let releaseHang: (value: string) => void = () => {};
  const fakeService = {
    echo: async (value: string) => `echo:${value}`,
    hang: () =>
      new Promise<string>((resolve) => {
        releaseHang = resolve;
      }),
    onTick: tick.event,
  };
  let serverProtocol: MessagePortProtocol | undefined;
  let channelServer: ChannelServer | undefined;
  if (withServer) {
    serverProtocol = new MessagePortProtocol(server);
    channelServer = new ChannelServer(serverProtocol, "test");
    channelServer.registerChannel(
      ISourceServerManagementService.channelName,
      ProxyChannel.fromService(fakeService),
    );
  }
  const connection = createMessagePortServiceConnection(client as unknown as MessagePort, {
    sourceServerManagementService: true,
  });
  return {
    clientPort: client,
    serverPort: server,
    services: connection.services,
    connection,
    tick,
    releaseHang: (value) => releaseHang(value),
    // withServer=false 时仅用于类型对齐，测试不会触及该分支。
    server: channelServer as ChannelServer,
  };
}

function serverActiveRequests(server: ChannelServer): number {
  // 诊断用：读取 server 内部活动请求表，验证 dispose/退订后无悬挂记录。
  return (server as unknown as { requests: Map<number, unknown> }).requests.size;
}

async function waitForInitialize(fixture: HarnessFixture): Promise<void> {
  const value = await fixture.services.sourceServerManagementService?.["echo"]("ping");
  assert.equal(value, "echo:ping");
}

test("dispose 将挂起 RPC 以 ConnectionClosed settle 并关闭底层 port", async () => {
  const fixture = await createHarness();
  await waitForInitialize(fixture);
  const pending = fixture.services.sourceServerManagementService?.["hang"]();
  fixture.connection.dispose();
  await assert.rejects(pending as Promise<string>, (error: unknown) => {
    const err = error as Error;
    return err.name === "ConnectionClosed";
  });
  assert.equal(fixture.clientPort.closeCalls, 1, "dispose 必须关闭 port 释放 attachment");
  // dispose 后新调用直接本地拒绝，不再进入线上队列。
  await assert.rejects(
    fixture.services.sourceServerManagementService?.["echo"]("late"),
    /disposed/,
  );
  fixture.releaseHang("unused");
});

test("dispose(reason) 用指定 reason settle 挂起请求", async () => {
  const fixture = await createHarness();
  await waitForInitialize(fixture);
  const pending = fixture.services.sourceServerManagementService?.["hang"]();
  fixture.connection.dispose(new Error("session superseded"));
  await assert.rejects(pending as Promise<string>, { message: "session superseded" });
  fixture.releaseHang("unused");
});

test("dispose 幂等，port 只关闭一次", async () => {
  const fixture = await createHarness();
  await waitForInitialize(fixture);
  fixture.connection.dispose();
  fixture.connection.dispose();
  assert.equal(fixture.clientPort.closeCalls, 1);
});

test("server 未出现时，dispose 仍能 settle 排队中的调用", async () => {
  const fixture = await createHarness(false);
  const pending = fixture.services.sourceServerManagementService?.["echo"]("never");
  fixture.connection.dispose();
  await assert.rejects(pending as Promise<string>, (error: unknown) => {
    const err = error as Error;
    return err.name === "ConnectionClosed";
  });
  assert.equal(fixture.clientPort.closed, true);
});

test("事件订阅在 dispose 后停止投递", async () => {
  const fixture = await createHarness();
  await waitForInitialize(fixture);
  const received: string[] = [];
  const listen = fixture.services.sourceServerManagementService?.["onTick"] as unknown as (
    listener: (value: string) => void,
  ) => { dispose: () => void };
  const subscription = listen((value) => received.push(value));
  // EventListen 帧要经 mock port 的微任务投递（与真实 MessagePort 一致），
  // 必须等 server 完成订阅后再 fire，否则首事件在订阅上线前被丢弃属预期行为。
  await flush();
  fixture.tick.fire("t1");
  await flush();
  await flush();
  assert.deepEqual(received, ["t1"]);
  fixture.connection.dispose();
  fixture.tick.fire("t2");
  await flush();
  assert.deepEqual(received, ["t1"], "dispose 后不得再向旧订阅者投递");
  void subscription;
});

test("last-listener 退订后该通道停止投递", async () => {
  const fixture = await createHarness();
  await waitForInitialize(fixture);
  const received: string[] = [];
  const listen = fixture.services.sourceServerManagementService?.["onTick"] as unknown as (
    listener: (value: string) => void,
  ) => { dispose: () => void };
  const subscription = listen((value) => received.push(value));
  await flush();
  fixture.tick.fire("t1");
  await flush();
  await flush();
  assert.deepEqual(received, ["t1"]);
  subscription.dispose();
  await flush();
  fixture.tick.fire("t2");
  await flush();
  await flush();
  assert.deepEqual(received, ["t1"], "最后一个监听者释放后不得继续收到事件");
  fixture.connection.dispose();
});

test("换代重连：dispose 旧连接不影响新连接的调用与事件", async () => {
  const oldFixture = await createHarness();
  await waitForInitialize(oldFixture);
  const pendingOld = oldFixture.services.sourceServerManagementService?.["hang"]();
  const newFixture = await createHarness();
  await waitForInitialize(newFixture);
  oldFixture.connection.dispose();
  await assert.rejects(pendingOld as Promise<string>, (error: unknown) => {
    const err = error as Error;
    return err.name === "ConnectionClosed";
  });
  const received: string[] = [];
  const listen = newFixture.services.sourceServerManagementService?.["onTick"] as unknown as (
    listener: (value: string) => void,
  ) => { dispose: () => void };
  listen((value) => received.push(value));
  await flush();
  newFixture.tick.fire("fresh");
  const echoed = await newFixture.services.sourceServerManagementService?.["echo"]("still-on");
  await flush();
  await flush();
  assert.equal(echoed, "echo:still-on");
  assert.deepEqual(received, ["fresh"]);
  newFixture.connection.dispose();
});

test("RemoteServiceAccess 的 channel 映射唯一且 windowProjectDirectory attach 幂等", () => {
  const names: string[] = [];
  const makeChannel = () => ({ call: async () => undefined, listen: () => () => {} });
  const channelClient = {
    getChannel: (name: string) => {
      names.push(name);
      return makeChannel();
    },
  } as unknown as IChannelClient;
  const access = new RemoteServiceAccess(channelClient, { windowProjectDirectory: true });
  assert.ok(access.windowProjectDirectory, "windowProjectDirectory 选项必须装配三个目录服务");
  assert.equal(new Set(names).size, names.length, `存在重复 channelName: ${names.join(", ")}`);
  const attached = access.attachWindowProjectDirectory(channelClient);
  assert.equal(attached, access.windowProjectDirectory, "重复 attach 必须幂等，不得重建代理");
  const captured = names.length;
  access.attachWindowProjectDirectory(channelClient);
  assert.equal(names.length, captured, "幂等 attach 不得再次 getChannel");
  assert.ok(
    !Object.keys(access).includes("providerProvisioningTargetService"),
    "Host-only 代理不得进入可枚举面",
  );
  assert.ok(access.providerProvisioningTargetService, "defineProperty 装配后必须可用");
});

type TickListener = (value: string) => void;
type TickEvent = (listener: TickListener) => { dispose: () => void };

function asTickEvent(fn: unknown): TickEvent {
  return fn as TickEvent;
}

test("同一远程事件的多个订阅拥有独立生命周期", async () => {
  const fixture = await createHarness();
  await waitForInitialize(fixture);
  // 每次属性访问都会新建远程 Event；两条订阅是两个独立的 EventListen 请求。
  const first: string[] = [];
  const second: string[] = [];
  const sub1 = asTickEvent(fixture.services.sourceServerManagementService?.["onTick"])((v) =>
    first.push(v),
  );
  const sub2 = asTickEvent(fixture.services.sourceServerManagementService?.["onTick"])((v) =>
    second.push(v),
  );
  await flush();
  fixture.tick.fire("t1");
  await flush();
  await flush();
  assert.deepEqual(first, ["t1"]);
  assert.deepEqual(second, ["t1"]);
  sub1.dispose();
  await flush();
  fixture.tick.fire("t2");
  await flush();
  await flush();
  assert.deepEqual(first, ["t1"], "已退订的订阅不得再收投递");
  assert.deepEqual(second, ["t1", "t2"], "其余订阅必须继续收投递");
  sub2.dispose();
  fixture.connection.dispose();
});

test("dispose 与事件 fire 同轮交错时，在途事件帧不得迟到投递", async () => {
  const fixture = await createHarness();
  await waitForInitialize(fixture);
  const received: string[] = [];
  const subscription = asTickEvent(fixture.services.sourceServerManagementService?.["onTick"])(
    (v) => received.push(v),
  );
  await flush();
  // 同步块内先 fire 再 dispose：事件帧仍在 mock port 微任务队列中，
  // dispose 后 ChannelClient 必须以 isDisposed 守卫丢弃在途帧，不得回调监听者。
  fixture.tick.fire("inflight");
  fixture.connection.dispose();
  await flush();
  await flush();
  assert.deepEqual(received, [], "dispose 后不得投递在途事件");
  assert.equal(fixture.clientPort.closed, true);
  void subscription;
});

test("dispose(reason) 只对首次调用生效，重复 dispose 不得改写拒绝原因", async () => {
  const fixture = await createHarness();
  await waitForInitialize(fixture);
  const pending = fixture.services.sourceServerManagementService?.["hang"]();
  fixture.connection.dispose(new Error("first reason"));
  fixture.connection.dispose(new Error("second reason"));
  await assert.rejects(pending as Promise<string>, { message: "first reason" });
  assert.equal(fixture.clientPort.closeCalls, 1);
  fixture.releaseHang("unused");
});

test("组合选项下 RemoteServiceAccess 装配全部指定 channel 且无重复", () => {
  const names: string[] = [];
  const channelClient = {
    getChannel: (name: string) => {
      names.push(name);
      return { call: async () => undefined, listen: () => () => {} };
    },
  } as unknown as IChannelClient;
  const access = new RemoteServiceAccess(channelClient, {
    sourceServerManagementService: true,
    windowProjectDirectory: true,
  });
  assert.ok(access.sourceServerManagementService, "sourceServerManagementService 选项必须装配代理");
  assert.ok(Object.keys(access).includes("sourceServerManagementService"));
  assert.deepEqual(
    names.filter((n) => n === ISourceServerManagementService.channelName).length,
    1,
    "source channel 必须恰好装配一次",
  );
  assert.equal(new Set(names).size, names.length, `存在重复 channelName: ${names.join(", ")}`);
});

test("connectViaMessagePort 返回装配完成的 accessor 且默认不装目录服务", () => {
  const { client } = createPortPair();
  const services = connectViaMessagePort(client as unknown as MessagePort);
  assert.ok(services instanceof RemoteServiceAccess);
  assert.equal(services.windowProjectDirectory, undefined, "未开启选项时不得装配目录服务");
  assert.ok(services.fileService, "基础代理必须可用");
  client.close();
});

test("换代 churn：多轮连接 dispose 后 server 侧无悬挂请求", async () => {
  for (let generation = 0; generation < 12; generation++) {
    const fixture = await createHarness();
    await waitForInitialize(fixture);
    const received: string[] = [];
    const subscription = asTickEvent(fixture.services.sourceServerManagementService?.["onTick"])(
      (value) => received.push(value),
    );
    await flush();
    fixture.tick.fire(`gen-${generation}`);
    await flush();
    await flush();
    // 新一代连接不得收到其他代的事件（每代 server/emitter 独立，出现即说明投递串线）。
    assert.deepEqual(received, [`gen-${generation}`]);
    const hang = fixture.services.sourceServerManagementService?.["hang"]();
    fixture.connection.dispose();
    await assert.rejects(hang as Promise<string>, (error: unknown) => {
      const err = error as Error;
      return err.name === "ConnectionClosed";
    });
    assert.equal(fixture.clientPort.closeCalls, 1);
    subscription.dispose();
    await flush();
    assert.equal(serverActiveRequests(fixture.server), 0, "dispose 后 server 请求表必须清空");
    fixture.server.dispose();
  }
});

test("退订后重新订阅：新订阅不得收到缓冲的旧事件", async () => {
  const fixture = await createHarness();
  await waitForInitialize(fixture);
  const first: string[] = [];
  const sub1 = asTickEvent(fixture.services.sourceServerManagementService?.["onTick"])((v) =>
    first.push(v),
  );
  await flush();
  fixture.tick.fire("old1");
  await flush();
  await flush();
  assert.deepEqual(first, ["old1"]);
  sub1.dispose();
  await flush();
  // 空窗期事件：server 侧源事件在无人订阅时 fire，不属于任何缓冲队列。
  fixture.tick.fire("gap");
  const second: string[] = [];
  const sub2 = asTickEvent(fixture.services.sourceServerManagementService?.["onTick"])((v) =>
    second.push(v),
  );
  await flush();
  fixture.tick.fire("fresh");
  await flush();
  await flush();
  assert.deepEqual(second, ["fresh"], "重新订阅只收新事件，不得回放 old1/gap");
  sub2.dispose();
  fixture.connection.dispose();
});

test("并发批量：多条挂起调用与事件订阅在 dispose 时全部 settle", async () => {
  const fixture = await createHarness();
  await waitForInitialize(fixture);
  const calls: Promise<unknown>[] = [];
  const received: string[] = [];
  // 同一同步块内发起调用、订阅并 dispose：microtask 尚未投递，任何回包/事件都不得先于 dispose 完成 settle。
  for (let i = 0; i < 10; i++) {
    calls.push(
      fixture.services.sourceServerManagementService?.["echo"](`c${i}`) as Promise<string>,
    );
  }
  asTickEvent(fixture.services.sourceServerManagementService?.["onTick"])((v) => received.push(v));
  fixture.tick.fire("burst");
  fixture.connection.dispose();
  const settled = await Promise.allSettled(calls);
  for (const outcome of settled) {
    assert.equal(outcome.status, "rejected");
    const err = (outcome as PromiseRejectedResult).reason as Error;
    assert.ok(
      err.name === "ConnectionClosed" || err.message.includes("disposed"),
      `挂起调用必须以 ConnectionClosed/disposed 终结，实际: ${err.name}/${err.message}`,
    );
  }
  await flush();
  await flush();
  assert.deepEqual(received, [], "dispose 丢弃在途事件帧后不得回调");
  assert.equal(fixture.clientPort.closeCalls, 1);
  fixture.server.dispose();
});
