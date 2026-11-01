import assert from "node:assert/strict";
import test from "node:test";
import { Emitter, toDisposable, type Event, type IDisposable } from "../src/foundation.js";
import { ChannelClient, ChannelServer } from "../src/channels.js";
import { ProxyChannel } from "../src/proxy-channel.js";
import { VSBuffer } from "../src/buffer.js";
import { BufferReader, deserialize } from "../src/serialization.js";
import type { IMessagePassingProtocol } from "../src/protocol.js";

interface ProxyService {
  readonly onDidChange: Event<string>;
  setValue(next: number): Promise<number>;
  fail(): Promise<never>;
}

/**
 * 组合夹具：真实 ProxyChannel 两端 + 内存直投协议。
 * 同步投递下必须先建客户端再建服务端，否则构造期发出的 Initialize 会被丢弃（见扫描 spec）。
 */
function composition() {
  const toClient = new Emitter<VSBuffer>();
  const toServer = new Emitter<VSBuffer>();
  const frames: { type: number; id: number }[] = [];
  const clientProtocol: IMessagePassingProtocol = {
    onMessage: toClient.event,
    send(data) {
      const reader = new BufferReader(data);
      const header = deserialize(reader);
      frames.push({ type: header[0] as number, id: header[1] as number });
      toServer.fire(data);
    },
  };
  const serverProtocol: IMessagePassingProtocol = {
    onMessage: toServer.event,
    send: (data) => toClient.fire(data),
  };

  const source = new Emitter<string>();
  let liveSourceListeners = 0;
  const counted: Event<string> = (listener) => {
    liveSourceListeners += 1;
    const inner = source.event(listener);
    return toDisposable(() => {
      liveSourceListeners -= 1;
      inner.dispose();
    });
  };

  const service = {
    onDidChange: counted,
    value: 0,
    setValue(next: number) {
      this.value = next;
      return this.value;
    },
    async fail(): Promise<never> {
      throw Object.assign(new Error("PROXY_FAIL"), { code: "PROXY", status: 503 });
    },
  };

  const client = new ChannelClient(clientProtocol);
  const server = new ChannelServer<string>(serverProtocol, "ctx", 1000, false);
  server.registerChannel("svc", ProxyChannel.fromService<string>(service));
  const proxy = ProxyChannel.toService<ProxyService>(client.getChannel("svc"));

  const clientTable = () => (client as unknown as { requests: Map<number, unknown> }).requests;
  const serverTable = () => (server as unknown as { requests: Map<number, unknown> }).requests;
  const count = (type: number) => frames.filter((frame) => frame.type === type).length;
  const cleanup = () => {
    client.dispose();
    server.dispose();
    source.dispose();
    toClient.dispose();
    toServer.dispose();
  };
  return {
    client,
    proxy,
    frames,
    count,
    clientTable,
    serverTable,
    cleanup,
    fireSource: (value: string) => source.fire(value),
    sourceListeners: () => liveSourceListeners,
  };
}

const LISTEN = 102;
const DISPOSE = 103;
const PROMISE = 100;
const PROMISE_CANCEL = 101;

test("代理属性每次读取产生独立订阅周期，服务端共享源监听只挂一次", async () => {
  const run = composition();
  try {
    const eventA = run.proxy.onDidChange;
    const eventB = run.proxy.onDidChange;
    assert.notEqual(eventA, eventB, "同一服务属性的两次读取是两个独立周期");

    const seenA: string[] = [];
    const seenB: string[] = [];
    const handleA = eventA((value) => seenA.push(value));
    const handleB = eventB((value) => seenB.push(value));
    assert.equal(run.count(LISTEN), 2, "两个周期各发一次 EventListen");
    assert.equal(run.sourceListeners(), 1, "服务端缓冲事件共享一个源监听");
    assert.equal(run.clientTable().size, 2);
    assert.equal(run.serverTable().size, 2);

    run.fireSource("v1");
    assert.deepEqual(seenA, ["v1"]);
    assert.deepEqual(seenB, ["v1"]);

    handleA.dispose();
    assert.equal(run.count(DISPOSE), 1, "周期结束只补一帧退订");
    assert.equal(run.sourceListeners(), 1, "另一周期仍存活，源监听不得解除");
    run.fireSource("v2");
    assert.deepEqual(seenA, ["v1"], "已结束的周期不再收事件");
    assert.deepEqual(seenB, ["v1", "v2"]);

    handleB.dispose();
    assert.equal(run.count(DISPOSE), 2);
    assert.equal(run.sourceListeners(), 0, "全部周期结束后服务端源监听归零");
    assert.equal(run.clientTable().size, 0);
    assert.equal(run.serverTable().size, 0);
  } finally {
    run.cleanup();
  }
});

test("代理事件的缓冲范围实测：首次订阅前与退订窗口内的事件不补发", async () => {
  const run = composition();
  try {
    run.fireSource("before-any-subscribe");
    const seen: string[] = [];
    const handle = run.proxy.onDidChange((value) => seen.push(value));
    assert.deepEqual(seen, [], "服务端源事件在第一次客户端订阅前没有监听者，不会补发");

    run.fireSource("live");
    assert.deepEqual(seen, ["live"]);

    handle.dispose();
    run.fireSource("gap");
    const again: string[] = [];
    const second = run.proxy.onDidChange((value) => again.push(value));
    assert.equal(run.count(LISTEN), 2, "重订使用新周期");
    assert.deepEqual(again, [], "退订窗口内的事件不补发");
    run.fireSource("after");
    assert.deepEqual(again, ["after"]);
    second.dispose();
    assert.equal(run.sourceListeners(), 0);
    assert.equal(run.clientTable().size, 0);
    assert.equal(run.serverTable().size, 0);
  } finally {
    run.cleanup();
  }
});

test("代理方法经客户端往返并保留既有错误字段", async () => {
  const run = composition();
  try {
    assert.equal(await run.proxy.setValue(41), 41);
    assert.equal(run.count(PROMISE), 1, "无取消令牌时不应附带取消帧");
    assert.equal(run.count(PROMISE_CANCEL), 0, "代理调用未传令牌，不该发出取消帧");
    await assert.rejects(
      () => run.proxy.fail(),
      (error: Error & Record<string, unknown>) => {
        assert.equal(error.message, "PROXY_FAIL");
        assert.equal(error.code, "PROXY");
        assert.equal(error.status, 503);
        return true;
      },
    );
    assert.equal(run.count(PROMISE), 2, "fail 同样上线一条请求");
    assert.equal(run.clientTable().size, 0);
    assert.equal(run.serverTable().size, 0);

    run.client.dispose();
    await assert.rejects(() => run.proxy.setValue(42), /ChannelClient is disposed/);
    assert.equal(run.count(PROMISE), 2, "释放后的调用不上线");
    assert.equal(run.count(PROMISE_CANCEL), 0, "已排空的表不产生取消帧");
  } finally {
    run.cleanup();
  }
});

test("代理多周期与并发调用在客户端释放时各终结一次且两侧归零", async () => {
  const run = composition();
  try {
    const handles: IDisposable[] = [];
    for (let index = 0; index < 5; index++) {
      const event = run.proxy.onDidChange;
      handles.push(event(() => {}));
      handles.push(event(() => {}));
    }
    assert.equal(run.count(LISTEN), 5, "五个周期各一次 EventListen");
    const done: string[] = [];
    for (let index = 0; index < 10; index++) {
      void run.proxy.setValue(index).then(
        (value) => done.push(`fulfilled:${value}`),
        (error: Error) => done.push(`rejected:${error.message}`),
      );
    }
    assert.equal(run.clientTable().size, 15, "5 个周期 + 10 条在途调用");
    assert.equal(run.serverTable().size, 15);

    // 先让已完成的一批正常回收：微任务 flush 后只剩 5 个订阅周期。
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    assert.equal(done.length, 10, "已回包的调用各 settle 一次");
    assert.equal(
      done.filter((item) => item.startsWith("fulfilled:")).length,
      10,
      "已完成的调用保持结果",
    );
    assert.equal(run.clientTable().size, 5, "完成的调用不占表");
    assert.equal(run.serverTable().size, 5);

    // 再制造真正在途的调用：与释放同一同步块发起，必定被释放终结。
    const inflight: string[] = [];
    for (let index = 0; index < 3; index++) {
      void run.proxy.setValue(100 + index).then(
        (value) => inflight.push(`fulfilled:${value}`),
        (error: Error) => inflight.push(`rejected:${error.message}`),
      );
    }
    assert.equal(run.clientTable().size, 8, "5 个周期 + 3 条在途调用");
    run.client.dispose();
    assert.equal(run.clientTable().size, 0, "释放同步排空唯一表");
    assert.equal(run.count(DISPOSE), 5, "五个周期各补一帧退订");
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    assert.deepEqual(
      inflight,
      Array(3).fill("rejected:ChannelClient disposed"),
      "在途调用各终结一次",
    );
    assert.equal(run.serverTable().size, 0, "终结帧抵达对端后服务端归零");
    assert.equal(run.sourceListeners(), 0);
    for (const handle of handles) handle.dispose();
    assert.equal(run.count(DISPOSE), 5, "释放后再撤销句柄不产生第二帧");
    assert.equal(done.length, 10, "已 settle 的调用不被释放改写");
  } finally {
    run.cleanup();
  }
});
