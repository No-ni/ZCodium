import assert from "node:assert/strict";
import test from "node:test";
import { Emitter, toDisposable, type IDisposable } from "../src/foundation.js";
import { ChannelClient, ChannelServer } from "../src/channels.js";
import type { IServerChannel } from "../src/channels.shared.js";
import { VSBuffer } from "../src/buffer.js";
import { SocketProtocol, type IMessagePassingProtocol, type ISocket } from "../src/protocol.js";

/**
 * 把每个写出帧按 chunkSize 切片同步投递，制造 socket/stdio 真实可能出现的分片。
 * chunkSize <= 0 表示整帧一次投递，用于对照多帧合并的场景。
 */
function makeTransport(chunkSize: number) {
  const clientIn = new Emitter<VSBuffer>();
  const serverIn = new Emitter<VSBuffer>();
  const splitDeliver = (data: VSBuffer, sink: Emitter<VSBuffer>) => {
    if (chunkSize <= 0) {
      sink.fire(data);
      return;
    }
    for (let offset = 0; offset < data.byteLength; offset += chunkSize) {
      sink.fire(data.slice(offset, Math.min(offset + chunkSize, data.byteLength)));
    }
  };
  const socket = (inbound: Emitter<VSBuffer>, peer: Emitter<VSBuffer>): ISocket => ({
    onData: inbound.event,
    onClose: () => toDisposable(() => {}),
    onEnd: () => toDisposable(() => {}),
    write: (data: VSBuffer) => splitDeliver(data, peer),
    end() {},
    async drain() {},
    dispose() {},
  });
  const client: IMessagePassingProtocol = new SocketProtocol(socket(clientIn, serverIn));
  const server: IMessagePassingProtocol = new SocketProtocol(socket(serverIn, clientIn));
  return {
    client,
    server,
    dispose() {
      (server as SocketProtocol).dispose();
      (client as SocketProtocol).dispose();
      serverIn.dispose();
      clientIn.dispose();
    },
  };
}

function echoFixture() {
  const bus = new Emitter<unknown>();
  let attaches = 0;
  let releases = 0;
  const channel = {
    call(_ctx: string, command: string, arg: unknown): Promise<unknown> {
      if (command === "echo") return Promise.resolve(arg);
      if (command === "fail") {
        throw Object.assign(new Error("FRAGMENTED_FAILURE"), {
          code: "FRAG",
          status: 429,
          retryAfterMs: 7,
          details: { nested: [1, 2, 3] },
        });
      }
      return Promise.reject(new Error(`UNSUPPORTED:${command}`));
    },
    listen(_ctx: string, event: string) {
      if (event !== "tick") throw new Error("LISTEN_UNSUPPORTED");
      attaches += 1;
      return (listener: (value: unknown) => void): IDisposable => {
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
    fire: (value: unknown) => bus.fire(value),
    counts: () => ({ attaches, releases }),
    disposeBus: () => bus.dispose(),
  };
}

function env(chunkSize: number) {
  const transport = makeTransport(chunkSize);
  const fx = echoFixture();
  // 同步投递的夹具必须先建客户端：Initialize 在 ChannelServer 构造时就发出，
  // 若此时 ChannelClient 尚未订阅 onMessage，握手帧会被丢弃且无法补发，所有请求只能永远等待。
  const client = new ChannelClient(transport.client);
  const server = new ChannelServer<string>(transport.server, "ctx", 1000, false);
  server.registerChannel("fixture", fx.channel as unknown as IServerChannel<string>);
  const remote = client.getChannel("fixture");
  const clientTable = () => (client as unknown as { requests: Map<number, unknown> }).requests;
  const serverTable = () => (server as unknown as { requests: Map<number, unknown> }).requests;
  const settle = async (times = 8) => {
    for (let index = 0; index < times; index++) await Promise.resolve();
  };
  const cleanup = () => {
    client.dispose();
    server.dispose();
    fx.disposeBus();
    transport.dispose();
  };
  return { client, server, fx, remote, clientTable, serverTable, settle, cleanup };
}

const chunkSizes = [1, 2, 3, 5, 7, 12, 13, 14, 64];

const boundaryArgs: { label: string; value: unknown }[] = [
  { label: "empty-string", value: "" },
  { label: "ascii-127", value: "x".repeat(127) },
  { label: "ascii-128", value: "x".repeat(128) },
  { label: "ascii-129", value: "x".repeat(129) },
  { label: "utf8-126-bytes", value: "中".repeat(42) },
  { label: "utf8-129-bytes", value: "中".repeat(43) },
  { label: "utf8-16383-bytes", value: "中".repeat(5461) },
  { label: "int-zero", value: 0 },
  { label: "int-negative-one", value: -1 },
  { label: "int-127", value: 127 },
  { label: "int-128", value: 128 },
  { label: "int-16384", value: 16384 },
  { label: "int-2097152", value: 2097152 },
  { label: "int-negative", value: -98765 },
  { label: "float", value: 1.5 },
  { label: "bool", value: true },
  { label: "null", value: null },
  { label: "undefined", value: undefined },
  { label: "array", value: [1, "two", { three: 3 }] },
  { label: "object", value: { a: 1, b: { c: [1, 2, 3] }, d: "中" } },
  { label: "uint8", value: new Uint8Array([0, 1, 127, 128, 255]) },
  { label: "nested-uint8", value: { bytes: new Uint8Array([9, 8, 7]) } },
];

test("单字节起的各种分片尺寸下，边界载荷仍能原样往返", { timeout: 15000 }, async (t) => {
  for (const chunkSize of chunkSizes) {
    const run = env(chunkSize);
    try {
      await run.settle();
      for (const item of boundaryArgs) {
        const actual = await run.remote.call("echo", item.value);
        if (typeof item.value === "string" || typeof item.value !== "object") {
          assert.deepEqual(actual, item.value, `chunk=${chunkSize} case=${item.label}`);
        } else if (item.value instanceof Uint8Array) {
          assert.equal(actual instanceof Uint8Array, true, `chunk=${chunkSize} case=${item.label}`);
          assert.deepEqual(Array.from(actual as Uint8Array), Array.from(item.value), item.label);
        } else {
          assert.deepEqual(actual, item.value, `chunk=${chunkSize} case=${item.label}`);
        }
      }
      assert.equal(run.clientTable().size, 0, `chunk=${chunkSize}`);
      assert.equal(run.serverTable().size, 0, `chunk=${chunkSize}`);
      t.diagnostic(`chunk=${chunkSize}: ${boundaryArgs.length} cases ok`);
    } finally {
      run.cleanup();
    }
  }
});

test("整帧合并投递与多帧并发在同一条连接上按序完成", { timeout: 15000 }, async () => {
  const run = env(0);
  try {
    await run.settle();
    const calls: Promise<unknown>[] = [];
    for (let index = 0; index < 40; index++) calls.push(run.remote.call("echo", `call-${index}`));
    const seen: string[] = [];
    const subscriptions = Array.from({ length: 6 }, (_unused, index) => {
      const handles: IDisposable[] = [];
      const handle = run.remote.listen("tick")((value) => seen.push(`${index}:${String(value)}`));
      handles.push(handle);
      return handles;
    });
    await run.settle();
    const results = await Promise.all(calls);
    assert.deepEqual(
      results,
      Array.from({ length: 40 }, (_unused, index) => `call-${index}`),
      "并发调用必须按各自请求回收，不串号",
    );
    assert.equal(run.fx.counts().attaches, 6, "六条订阅都上线");
    run.fx.fire("burst");
    await run.settle();
    assert.equal(seen.length, 6, "每周期各收一次");
    assert.deepEqual([...seen].sort(), [
      "0:burst",
      "1:burst",
      "2:burst",
      "3:burst",
      "4:burst",
      "5:burst",
    ]);
    for (const handles of subscriptions) for (const handle of handles) handle.dispose();
    await run.settle();
    assert.equal(run.fx.counts().releases, 6, "退订全部抵达对端");
    assert.equal(run.clientTable().size, 0);
    assert.equal(run.serverTable().size, 0);
  } finally {
    run.cleanup();
  }
});

test("大载荷与二进制字段在分片投递下字节不变", { timeout: 15000 }, async (t) => {
  for (const chunkSize of [1, 64, 1024, 65536]) {
    const run = env(chunkSize);
    try {
      await run.settle();
      const bigText = "长".repeat(70000);
      const roundText = await run.remote.call<string>("echo", bigText);
      assert.equal(roundText.length, bigText.length, `chunk=${chunkSize}`);
      assert.equal(roundText, bigText, `chunk=${chunkSize}`);
      const bigBytes = new Uint8Array(65540);
      for (let index = 0; index < bigBytes.length; index++) bigBytes[index] = index % 251;
      const roundBytes = await run.remote.call<Uint8Array>("echo", bigBytes);
      assert.equal(roundBytes.byteLength, bigBytes.byteLength, `chunk=${chunkSize}`);
      assert.deepEqual(Array.from(roundBytes.subarray(0, 8)), Array.from(bigBytes.subarray(0, 8)));
      assert.equal(roundBytes[65539], bigBytes[65539], `chunk=${chunkSize}`);
      const mixed = await run.remote.call<{ text: string; bytes: Uint8Array }>("echo", {
        text: bigText.slice(0, 300),
        bytes: bigBytes.subarray(0, 300),
      });
      assert.equal(mixed.text, bigText.slice(0, 300), `chunk=${chunkSize}`);
      assert.equal(mixed.bytes instanceof Uint8Array, true, `chunk=${chunkSize}`);
      assert.deepEqual(Array.from(mixed.bytes), Array.from(bigBytes.subarray(0, 300)));
      assert.equal(run.clientTable().size, 0, `chunk=${chunkSize}`);
      t.diagnostic(`chunk=${chunkSize}: large payloads ok`);
    } finally {
      run.cleanup();
    }
  }
});

test("分片传输下服务端错误仍按既有字段传播", { timeout: 15000 }, async () => {
  for (const chunkSize of [1, 13, 997]) {
    const run = env(chunkSize);
    try {
      await run.settle();
      await assert.rejects(
        () => run.remote.call("fail"),
        (error: Error & Record<string, unknown>) => {
          assert.equal(error.message, "FRAGMENTED_FAILURE", `chunk=${chunkSize}`);
          assert.equal(error.code, "FRAG", `chunk=${chunkSize}`);
          assert.equal(error.status, 429, `chunk=${chunkSize}`);
          assert.equal(error.retryAfterMs, 7, `chunk=${chunkSize}`);
          assert.deepEqual(error.details, { nested: [1, 2, 3] }, `chunk=${chunkSize}`);
          return true;
        },
      );
      await assert.rejects(() => run.remote.call("nope"), /UNSUPPORTED:nope/, `chunk=${chunkSize}`);
      assert.equal(run.clientTable().size, 0, `chunk=${chunkSize}`);
      assert.equal(run.serverTable().size, 0, `chunk=${chunkSize}`);
    } finally {
      run.cleanup();
    }
  }
});

test("事件在大载荷与分片投递下按序送达，退订后两侧归零", { timeout: 15000 }, async (t) => {
  for (const chunkSize of [1, 3, 256]) {
    const run = env(chunkSize);
    try {
      await run.settle();
      const values: unknown[] = [];
      const subscription = run.remote.listen<unknown>("tick")((value) => values.push(value));
      await run.settle();
      const payload = { text: "结".repeat(9000), seq: [1, 2, 3] };
      run.fx.fire(payload);
      run.fx.fire("tail");
      await run.settle();
      assert.equal(values.length, 2, `chunk=${chunkSize}`);
      assert.deepEqual(values[0], payload, `chunk=${chunkSize}`);
      assert.equal(values[1], "tail", `chunk=${chunkSize}`);
      subscription.dispose();
      await run.settle();
      run.fx.fire("ghost");
      await run.settle();
      assert.equal(values.length, 2, `chunk=${chunkSize}: 退订后仍收到事件`);
      assert.equal(run.fx.counts().releases, 1, `chunk=${chunkSize}`);
      assert.equal(run.clientTable().size, 0, `chunk=${chunkSize}`);
      assert.equal(run.serverTable().size, 0, `chunk=${chunkSize}`);
      t.diagnostic(`chunk=${chunkSize}: events ok`);
    } finally {
      run.cleanup();
    }
  }
});
