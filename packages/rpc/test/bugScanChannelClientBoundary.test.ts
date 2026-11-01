import assert from "node:assert/strict";
import test from "node:test";
import { Emitter } from "../src/foundation.js";
import { BufferReader, BufferWriter, deserialize, serialize } from "../src/serialization.js";
import { ChannelClient } from "../src/channels.js";
import type { IMessagePassingProtocol } from "../src/protocol.js";
import type { VSBuffer } from "../src/buffer.js";

// 线协议常量与 channels.shared.ts 的 const enum 保持一致，测试只按帧观察行为。
const PROMISE = 100;
const PROMISE_CANCEL = 101;
const EVENT_LISTEN = 102;
const EVENT_DISPOSE = 103;
const INITIALIZE = 200;
const PROMISE_SUCCESS = 201;
const PROMISE_ERROR = 202;
const PROMISE_ERROR_OBJ = 203;
const EVENT_FIRE = 204;

function encoded(header: unknown[], body?: unknown): VSBuffer {
  const writer = new BufferWriter();
  serialize(writer, header);
  serialize(writer, body);
  return writer.buffer;
}

function decodedHeader(buffer: VSBuffer): any[] {
  const reader = new BufferReader(buffer);
  return deserialize(reader);
}

interface Frame {
  type: number;
  id: number;
  header: any[];
}

/** 受控内存协议：同步投递帧，测试可决定回包时机与抛错点。 */
function harness(
  send?: (frame: Frame, reply: (header: unknown[], body?: unknown) => void) => void,
) {
  const input = new Emitter<VSBuffer>();
  const frames: Frame[] = [];
  const protocol: IMessagePassingProtocol = {
    onMessage: input.event,
    send(data) {
      const header = decodedHeader(data);
      const frame: Frame = { type: header[0], id: header[1], header };
      frames.push(frame);
      send?.(frame, (replyHeader, replyBody) => input.fire(encoded(replyHeader, replyBody)));
    },
  };
  const client = new ChannelClient(protocol);
  // 唯一 requests 表是存活事实；断言以该表归零检查释放，不新增第二份计数。
  const live = () => (client as unknown as { requests: Map<number, unknown> }).requests;
  const initialized = () => input.fire(encoded([INITIALIZE]));
  const deliver = (header: unknown[], body?: unknown) => input.fire(encoded(header, body));
  return { client, frames, live, initialized, deliver, channel: client.getChannel("fixture") };
}

function settled<T>(promise: Promise<T>): Promise<{ status: string; value?: T; reason?: Error }> {
  return promise.then(
    (value) => ({ status: "fulfilled", value }),
    (reason: Error) => ({ status: "rejected", reason }),
  );
}

test("无人监听远端事件时，握手前撤回的订阅永不上线", async () => {
  const t = harness();
  const seen: unknown[] = [];
  const subscription = t.channel.listen("tick")((value) => seen.push(value));
  assert.deepEqual(t.frames, [], "第一个监听只登记等待请求，未初始化前不发帧");
  subscription.dispose();
  t.initialized();
  await Promise.resolve();
  assert.deepEqual(t.frames, [], "等待期退订不得留下 EventListen");
  assert.equal(t.live().size, 0);
});

test("同一个远端事件的多个监听共用一条订阅，只在最后一个离开时退订", () => {
  const t = harness();
  t.initialized();
  const values: string[] = [];
  const event = t.channel.listen("tick");
  const first = event((value) => values.push(`a:${value}`));
  const second = event((value) => values.push(`b:${value}`));
  assert.deepEqual(
    t.frames.map((frame) => frame.type),
    [EVENT_LISTEN],
    "同一订阅周期只发一次 EventListen",
  );
  const id = t.frames[0].id;
  t.deliver([EVENT_FIRE, id], "v");
  assert.deepEqual(values, ["a:v", "b:v"], "一次 EventFire 投递给该周期的每个监听");
  first.dispose();
  assert.deepEqual(
    t.frames.map((frame) => frame.type),
    [EVENT_LISTEN],
    "仍有监听时不得提前退订",
  );
  assert.equal(t.live().size, 1);
  t.deliver([EVENT_FIRE, id], "still");
  assert.deepEqual(values, ["a:v", "b:v", "b:still"], "退出的监听不再收事件，留下的继续");
  second.dispose();
  assert.deepEqual(
    t.frames.map((frame) => frame.type),
    [EVENT_LISTEN, EVENT_DISPOSE],
  );
  assert.equal(t.live().size, 0);
  t.deliver([EVENT_FIRE, id], "late");
  assert.deepEqual(values, ["a:v", "b:v", "b:still"], "周期结束后的迟到事件被丢弃");
});

test("分别调用 listen 建立独立订阅周期，退订只结束各自周期", () => {
  const t = harness();
  t.initialized();
  const values: string[] = [];
  const a = t.channel.listen("tick")((value) => values.push(`a:${value}`));
  const b = t.channel.listen("tick")((value) => values.push(`b:${value}`));
  assert.deepEqual(
    t.frames.map((frame) => frame.type),
    [EVENT_LISTEN, EVENT_LISTEN],
  );
  assert.notEqual(t.frames[0].id, t.frames[1].id, "每个周期分配新 id");
  // 只结束第一个周期：第二个周期仍活跃，不得向对端发出它的退订。
  a.dispose();
  assert.deepEqual(
    t.frames.map((frame) => frame.type),
    [EVENT_LISTEN, EVENT_LISTEN, EVENT_DISPOSE],
  );
  assert.equal(t.frames[2].id, t.frames[0].id);
  assert.equal(t.live().size, 1);
  b.dispose();
  assert.equal(t.live().size, 0);
});

test("连接释放后监听句柄的 dispose 不再产生第二个退订帧", () => {
  const t = harness();
  t.initialized();
  const subscription = t.channel.listen("tick")(() => {});
  const before = t.frames.length;
  t.client.dispose();
  assert.deepEqual(
    t.frames.slice(before).map((frame) => frame.type),
    [EVENT_DISPOSE],
    "连接释放按已发送事实尽力通知一次对端",
  );
  subscription.dispose();
  assert.equal(t.frames.length, before + 1, "调用方后到的 dispose 不能重复退订");
  assert.equal(t.live().size, 0);
});

test("等待期请求在握手前被连接释放时不发取消帧，只本地终结", async () => {
  const t = harness();
  const outcome = settled(t.channel.call("work"));
  const subOutcome = t.channel.listen("tick")(() => {});
  t.client.dispose();
  assert.deepEqual(t.frames, [], "未上线的请求没有对端可通知");
  assert.equal((await outcome).status, "rejected");
  assert.equal(t.live().size, 0);
  subOutcome.dispose();
});

test("退订帧发送失败不复活请求，也不阻塞后续帧", () => {
  let breakDispose = false;
  const t = harness((frame, reply) => {
    if (frame.type === EVENT_DISPOSE && breakDispose) throw new Error("transport down");
    if (frame.type === EVENT_LISTEN) reply([INITIALIZE]);
  });
  t.initialized();
  const subscription = t.channel.listen("tick")(() => {});
  breakDispose = true;
  subscription.dispose();
  assert.equal(t.live().size, 0, "本地终结不能被对端通知失败撤销");
  breakDispose = false;
  const next = settled(t.channel.call("work"));
  assert.equal(t.frames[t.frames.length - 1].type, PROMISE, "后续请求仍能发送");
  t.client.dispose();
  void next;
});

test("已成功的调用之后取消令牌回调不再改写结局", async () => {
  let notify: (() => void) | undefined;
  const t = harness((frame, reply) => {
    if (frame.type === PROMISE) reply([PROMISE_SUCCESS, frame.id], "value");
  });
  t.initialized();
  const token = {
    isCancellationRequested: false,
    onCancellationRequested(listener: () => void) {
      notify = listener;
      return { dispose() {} };
    },
  };
  assert.equal(await t.channel.call("work", undefined, token), "value");
  notify?.();
  assert.equal(t.live().size, 0, "终结后的取消回调不能再登记第二份存活");
  assert.equal(
    await t.channel.call("again", undefined, token),
    "value",
    "同一令牌可交给后续调用继续使用",
  );
});

test("成功与失败结局都释放取消订阅句柄且表归零", async () => {
  let released = 0;
  const t = harness((frame, reply) => {
    if (frame.type !== PROMISE) return;
    if (frame.header[3] === "work") reply([PROMISE_SUCCESS, frame.id], "value");
    else
      reply([PROMISE_ERROR, frame.id], { message: "boom", name: "ServerSide", stack: undefined });
  });
  t.initialized();
  const token = () => ({
    isCancellationRequested: false,
    onCancellationRequested() {
      return {
        dispose() {
          released += 1;
        },
      };
    },
  });
  assert.equal(await t.channel.call("work", undefined, token()), "value");
  await assert.rejects(() => t.channel.call("fail", undefined, token()), /boom/);
  assert.equal(released, 2, "成功与失败都必须解除取消订阅");
  assert.equal(t.live().size, 0);
});

test("服务端错误字段与原始错误对象按既有契约传播", async () => {
  const t = harness((frame, reply) => {
    if (frame.header[3] === "fields") {
      reply([PROMISE_ERROR, frame.id], {
        message: "boom",
        name: "ServerSide",
        stack: ["line1", "line2"],
        code: "E_CODE",
        kind: "rate",
        status: 429,
        retryAfterMs: 5,
        taskId: "task-1",
        traceId: "trace-1",
      });
      return;
    }
    reply([PROMISE_ERROR_OBJ, frame.id], { reason: "raw" });
  });
  t.initialized();
  await assert.rejects(
    () => t.channel.call("fields"),
    (error: Error & Record<string, unknown>) => {
      assert.equal(error.message, "boom");
      assert.equal(error.name, "ServerSide");
      assert.equal(error.stack, "line1\nline2");
      assert.equal(error.code, "E_CODE");
      assert.equal(error.kind, "rate");
      assert.equal(error.status, 429);
      assert.equal(error.retryAfterMs, 5);
      assert.equal(error.taskId, "task-1");
      assert.equal(error.traceId, "trace-1");
      return true;
    },
  );
  const raw = await settled(t.channel.call("object"));
  assert.equal(raw.status, "rejected");
  assert.deepEqual(raw.reason, { reason: "raw" }, "非 Error 负载按原对象交给调用方");
  assert.equal(t.live().size, 0);
});

test("重投递的握手帧不会重复发送已在途的请求", async () => {
  const t = harness();
  const seen: unknown[] = [];
  const subscription = t.channel.listen("tick")((value) => seen.push(value));
  t.initialized();
  await Promise.resolve();
  t.initialized();
  await Promise.resolve();
  assert.deepEqual(
    t.frames.map((frame) => frame.type),
    [EVENT_LISTEN],
    "第二个 Initialize 只重排仍等待的请求",
  );
  assert.equal(t.live().size, 1);
  subscription.dispose();
});

test("已取消的令牌在写线前终结，迟到返回的句柄立即释放", async () => {
  let released = 0;
  const t = harness();
  t.initialized();
  const outcome = await settled(
    t.channel.call("work", undefined, {
      isCancellationRequested: false,
      onCancellationRequested(listener: () => void) {
        listener();
        return {
          dispose() {
            released += 1;
          },
        };
      },
    }),
  );
  assert.equal(outcome.status, "rejected");
  assert.match(outcome.reason?.message ?? "", /Cancelled/);
  assert.equal(released, 1);
  assert.deepEqual(t.frames, [], "同步取消不得留下请求帧或取消帧");
  assert.equal(t.live().size, 0);
});

test("混合在途请求在连接释放时各自终结一次", async () => {
  const t = harness();
  t.initialized();
  const callOutcome = settled(t.channel.call("work"));
  const listen = t.channel.listen("tick")(() => {});
  t.client.dispose();
  const outcome = await callOutcome;
  assert.equal(outcome.status, "rejected");
  assert.equal(outcome.reason?.name, "ConnectionClosed");
  assert.equal(t.live().size, 0);
  assert.deepEqual(
    t.frames.map((frame) => frame.type),
    [PROMISE, EVENT_LISTEN, PROMISE_CANCEL, EVENT_DISPOSE],
  );
  listen.dispose();
});
