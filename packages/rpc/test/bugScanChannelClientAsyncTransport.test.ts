import assert from "node:assert/strict";
import test from "node:test";
import { MessageChannel } from "node:worker_threads";
import {
  CancellationTokenSource,
  Emitter,
  toDisposable,
  type CancellationToken,
  type IDisposable,
} from "../src/foundation.js";
import { ChannelClient, ChannelServer } from "../src/channels.js";
import type { IServerChannel } from "../src/channels.shared.js";
import { VSBuffer } from "../src/buffer.js";
import {
  createQueuePair,
  MessagePortProtocol,
  SocketProtocol,
  type IMessagePassingProtocol,
  type ISocket,
  type MessagePortLike,
} from "../src/protocol.js";

type TransportKind = "message-port" | "queue-pair" | "socket";
const kinds: TransportKind[] = ["message-port", "queue-pair", "socket"];

interface Transport {
  client: IMessagePassingProtocol;
  server: IMessagePassingProtocol;
  dispose(): void;
}

function makeTransport(kind: TransportKind): Transport {
  if (kind === "message-port") {
    const { port1, port2 } = new MessageChannel();
    const client = new MessagePortProtocol(port1 as unknown as MessagePortLike);
    const server = new MessagePortProtocol(port2 as unknown as MessagePortLike);
    return {
      client,
      server,
      dispose() {
        client.disconnect();
        server.disconnect();
      },
    };
  }
  if (kind === "queue-pair") {
    const [client, server] = createQueuePair();
    return { client, server, dispose() {} };
  }
  // 真实 SocketProtocol 装帧，投递改到宏任务，避免同步栈回灌掩盖时序问题。
  const clientIn = new Emitter<VSBuffer>();
  const serverIn = new Emitter<VSBuffer>();
  const socket = (inbound: Emitter<VSBuffer>, peer: Emitter<VSBuffer>): ISocket => ({
    onData: inbound.event,
    onClose: () => toDisposable(() => {}),
    onEnd: () => toDisposable(() => {}),
    write: (data: VSBuffer) => {
      setTimeout(() => peer.fire(data), 0);
    },
    end() {},
    async drain() {},
    dispose() {},
  });
  const client = new SocketProtocol(socket(clientIn, serverIn));
  const server = new SocketProtocol(socket(serverIn, clientIn));
  return {
    client,
    server,
    dispose() {
      client.dispose();
      server.dispose();
      clientIn.dispose();
      serverIn.dispose();
    },
  };
}

function serverFixture() {
  const bus = new Emitter<string>();
  let attaches = 0;
  let releases = 0;
  let cancels = 0;
  // 受控服务端夹具按具体签名实现，注册时一次性适配 IServerChannel 的泛型契约。
  const channel = {
    call(_ctx: string, command: string, arg: unknown, token?: CancellationToken): Promise<string> {
      if (command === "hang") {
        return new Promise<string>((resolvePromise, rejectPromise) => {
          token?.onCancellationRequested(() => {
            cancels += 1;
            rejectPromise(new Error("SERVER_CANCELLED"));
          });
          void resolvePromise;
        });
      }
      return Promise.resolve(`echo:${String(arg ?? "")}`);
    },
    listen(_ctx: string, event: string) {
      if (event !== "tick") throw new Error("SERVER_LISTEN_UNSUPPORTED");
      attaches += 1;
      return (listener: (value: string) => void): IDisposable => {
        const inner = bus.event(listener);
        return toDisposable(() => {
          inner.dispose();
          releases += 1;
        });
      };
    },
  };
  return {
    channel,
    bus,
    fire: (value: string) => bus.fire(value),
    counts: () => ({ attaches, releases, cancels }),
  };
}

async function fixture(kind: TransportKind) {
  const transport = makeTransport(kind);
  const fx = serverFixture();
  const server = new ChannelServer<string>(transport.server, "ctx", 1000, false);
  server.registerChannel("fixture", fx.channel as unknown as IServerChannel<string>);
  const client = new ChannelClient(transport.client);
  const cleanup: (() => void)[] = [
    () => client.dispose(),
    () => server.dispose(),
    () => fx.bus.dispose(),
    () => transport.dispose(),
  ];
  const clientTable = () => (client as unknown as { requests: Map<number, unknown> }).requests;
  const serverTable = () => (server as unknown as { requests: Map<number, unknown> }).requests;
  const settle = async (times = 6) => {
    for (let index = 0; index < times; index++)
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
  };
  return {
    client,
    server,
    fx,
    cleanup,
    clientTable,
    serverTable,
    settle,
    remote: client.getChannel("fixture"),
  };
}

function tracked(promise: Promise<unknown>, sink: string[]) {
  void promise.then(
    (value) => sink.push(`fulfilled:${String(value)}`),
    (error: Error) => sink.push(`rejected:${error.message}`),
  );
}

test("真实异步传输下订阅、事件投递、退订与重订形成闭环", async (t) => {
  for (const kind of kinds) {
    const env = await fixture(kind);
    try {
      await env.settle();
      const values: string[] = [];
      const subscription = env.remote.listen<string>("tick")((value) => values.push(value));
      await env.settle();
      assert.deepEqual(env.fx.counts(), { attaches: 1, releases: 0, cancels: 0 }, kind);
      assert.equal(env.serverTable().size, 1, kind);

      env.fx.fire("e1");
      await env.settle();
      assert.deepEqual(values, ["e1"], kind);

      subscription.dispose();
      await env.settle();
      assert.equal(env.serverTable().size, 0, `${kind}: 退订未抵达对端`);
      assert.equal(env.fx.counts().releases, 1, kind);
      assert.equal(env.clientTable().size, 0, kind);

      const again: string[] = [];
      const second = env.remote.listen<string>("tick")((value) => again.push(value));
      await env.settle();
      assert.equal(env.fx.counts().attaches, 2, kind);
      env.fx.fire("e2");
      await env.settle();
      assert.deepEqual(again, ["e2"], kind);
      assert.deepEqual(values, ["e1"], "旧周期不得收到新周期事件");
      second.dispose();
      await env.settle();
      assert.equal(env.fx.counts().releases, 2, kind);
      assert.equal(env.serverTable().size, 0, kind);

      env.fx.fire("ghost");
      await env.settle();
      assert.deepEqual([...values, ...again], ["e1", "e2"], kind);
      t.diagnostic(`${kind}: ok`);
    } finally {
      for (const dispose of env.cleanup.reverse()) dispose();
    }
  }
});

test("取消令牌经真实传输抵达服务端并在两侧各终结一次", async (t) => {
  for (const kind of kinds) {
    const env = await fixture(kind);
    const source = new CancellationTokenSource();
    try {
      await env.settle();
      const sink: string[] = [];
      tracked(env.remote.call("hang", undefined, source.token), sink);
      await env.settle();
      assert.equal(env.clientTable().size, 1, kind);
      assert.equal(env.serverTable().size, 1, kind);
      source.cancel();
      await env.settle();
      assert.deepEqual(sink, ["rejected:Cancelled"], kind);
      assert.equal(env.fx.counts().cancels, 1, `${kind}: 服务端 token 未收到取消`);
      assert.equal(env.clientTable().size, 0, kind);
      assert.equal(env.serverTable().size, 0, kind);
      source.cancel();
      await env.settle();
      assert.deepEqual(sink, ["rejected:Cancelled"], "重复取消不得二次 settle");
      t.diagnostic(`${kind}: ok`);
    } finally {
      source.dispose();
      for (const dispose of env.cleanup.reverse()) dispose();
    }
  }
});

test("握手前撤回的订阅在真实传输上不残留对端资源", async (t) => {
  for (const kind of kinds) {
    const env = await fixture(kind);
    try {
      // 同步块内订阅并立即退订，此时 Initialize 仍在途中。
      const subscription = env.remote.listen("tick")(() => {});
      subscription.dispose();
      await env.settle();
      assert.equal(env.clientTable().size, 0, kind);
      assert.equal(env.serverTable().size, 0, kind);
      const counts = env.fx.counts();
      assert.equal(
        counts.attaches,
        counts.releases,
        `${kind}: 对端残留 ${counts.attaches}/${counts.releases}`,
      );
      assert.equal(counts.attaches, 0, `${kind}: 未上线的周期不该抵达对端`);

      // 握手之后同一 tick 内订阅并退订：请求帧与退订帧必须按序配对。
      await env.settle();
      const live = env.remote.listen("tick")(() => {});
      live.dispose();
      await env.settle();
      const after = env.fx.counts();
      assert.equal(after.attaches, 1, `${kind}: 已上线周期应抵达对端`);
      assert.equal(after.releases, 1, `${kind}: 退订帧未抵达对端`);
      assert.equal(env.serverTable().size, 0, kind);
      assert.equal(env.clientTable().size, 0, kind);
      t.diagnostic(`${kind}: ok`);
    } finally {
      for (const dispose of env.cleanup.reverse()) dispose();
    }
  }
});

test("握手前登记的订阅在真实传输上补齐并可正常退订", async (t) => {
  for (const kind of kinds) {
    const env = await fixture(kind);
    try {
      const values: string[] = [];
      const subscription = env.remote.listen<string>("tick")((value) => values.push(value));
      const sink: string[] = [];
      tracked(env.remote.call("echo", "hi"), sink);
      await env.settle(10);
      assert.deepEqual(sink, ["fulfilled:echo:hi"], kind);
      assert.equal(env.fx.counts().attaches, 1, kind);
      env.fx.fire("late-init");
      await env.settle();
      assert.deepEqual(values, ["late-init"], kind);
      subscription.dispose();
      await env.settle();
      assert.equal(env.fx.counts().releases, 1, kind);
      assert.equal(env.serverTable().size, 0, kind);
      assert.equal(env.clientTable().size, 0, kind);
      t.diagnostic(`${kind}: ok`);
    } finally {
      for (const dispose of env.cleanup.reverse()) dispose();
    }
  }
});

test("客户端释放后在途调用与订阅在两侧各终结一次", async (t) => {
  for (const kind of kinds) {
    const env = await fixture(kind);
    try {
      await env.settle();
      const sink: string[] = [];
      const subscription = env.remote.listen("tick")(() => {});
      tracked(env.remote.call("hang"), sink);
      await env.settle();
      assert.equal(env.clientTable().size, 2, kind);
      env.client.dispose();
      assert.equal(env.clientTable().size, 0, `${kind}: 释放应同步排空唯一表`);
      await env.settle();
      assert.deepEqual(sink, ["rejected:ChannelClient disposed"], kind);
      assert.equal(env.serverTable().size, 0, `${kind}: 客户端释放后对端残留活动请求`);
      assert.equal(env.fx.counts().attaches, 1, kind);
      assert.equal(env.fx.counts().releases, 1, kind);
      subscription.dispose();
      await env.settle();
      assert.deepEqual(sink, ["rejected:ChannelClient disposed"], "释放后不得二次 settle");
      assert.equal(env.fx.counts().releases, 1, kind);
      t.diagnostic(`${kind}: ok`);
    } finally {
      for (const dispose of env.cleanup.reverse()) dispose();
    }
  }
});

test("并发调用与多订阅混跑后取消、退订、释放均精确归零", async (t) => {
  for (const kind of kinds) {
    const env = await fixture(kind);
    const sources: CancellationTokenSource[] = [];
    try {
      await env.settle();
      const sinks: string[][] = [];
      const settled: Promise<unknown>[] = [];
      for (let index = 0; index < 25; index++) {
        const bucket: string[] = [];
        sinks.push(bucket);
        settled.push(
          env.remote.call("echo", index).then(
            (value) => bucket.push(`fulfilled:${String(value)}`),
            (error: Error) => bucket.push(`rejected:${error.message}`),
          ),
        );
      }
      for (let index = 0; index < 25; index++) {
        const source = new CancellationTokenSource();
        sources.push(source);
        const bucket: string[] = [];
        sinks.push(bucket);
        settled.push(
          env.remote.call("hang", undefined, source.token).then(
            (value) => bucket.push(`fulfilled:${String(value)}`),
            (error: Error) => bucket.push(`rejected:${error.message}`),
          ),
        );
      }
      const cycles: { handles: IDisposable[]; seen: string[] }[] = [];
      for (let index = 0; index < 20; index++) {
        const seen: string[] = [];
        const handle = env.remote.listen<string>("tick")((value) => seen.push(value));
        cycles.push({ handles: [handle], seen });
      }
      await env.settle(10);
      assert.equal(env.clientTable().size, 45, kind);

      env.fx.fire("round1");
      await env.settle(10);
      for (const cycle of cycles) assert.deepEqual(cycle.seen, ["round1"], kind);

      // 取消一半挂起调用，退订一半订阅，再投递一轮。
      for (let index = 25; index < 40; index++) sources[index - 25].cancel();
      for (let index = 10; index < 20; index++)
        cycles[index].handles.splice(0).forEach((h) => h.dispose());
      env.fx.fire("round2");
      await env.settle(10);

      for (let index = 0; index < 25; index++) {
        assert.deepEqual(sinks[index], [`fulfilled:echo:${index}`], `${kind}: call ${index}`);
      }
      for (let index = 25; index < 40; index++) {
        assert.deepEqual(sinks[index], ["rejected:Cancelled"], `${kind}: cancel ${index}`);
      }
      for (let index = 40; index < 50; index++) {
        assert.deepEqual(sinks[index], [], `${kind}: 未取消的挂起调用不该提前 settle`);
      }
      for (let index = 0; index < 10; index++)
        assert.deepEqual(cycles[index].seen, ["round1", "round2"], kind);
      for (let index = 10; index < 20; index++)
        assert.deepEqual(cycles[index].seen, ["round1"], kind);
      assert.equal(env.fx.counts().attaches, 20, kind);
      assert.equal(env.fx.counts().releases, 10, kind);
      // 剩余存活：10 条未取消的挂起调用 + 10 条未退订的订阅。
      assert.equal(env.clientTable().size, 20, kind);
      assert.equal(env.serverTable().size, 20, kind);

      env.client.dispose();
      await env.settle(10);
      await Promise.allSettled(settled);
      for (const bucket of sinks)
        assert.equal(bucket.length, 1, `${kind}: 每个调用恰好 settle 一次`);
      for (let index = 40; index < 50; index++) {
        assert.deepEqual(sinks[index], ["rejected:ChannelClient disposed"], `${kind}: ${index}`);
      }
      assert.equal(env.clientTable().size, 0, kind);
      assert.equal(env.serverTable().size, 0, `${kind}: 并发压力后对端残留活动请求`);
      assert.equal(env.fx.counts().attaches, 20, kind);
      assert.equal(env.fx.counts().releases, 20, `${kind}: 并发压力后对端订阅残留`);
      for (const cycle of cycles) {
        for (const handle of cycle.handles.splice(0)) handle.dispose();
      }
      await env.settle();
      assert.equal(env.fx.counts().releases, 20, kind);
      t.diagnostic(`${kind}: ok`);
    } finally {
      for (const source of sources) source.dispose();
      for (const dispose of env.cleanup.reverse()) dispose();
    }
  }
});
