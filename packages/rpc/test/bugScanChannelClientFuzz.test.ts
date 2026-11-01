import assert from "node:assert/strict";
import test from "node:test";
import { Emitter, type IDisposable } from "../src/foundation.js";
import { BufferReader, BufferWriter, deserialize, serialize } from "../src/serialization.js";
import { ChannelClient } from "../src/channels.js";
import type { IMessagePassingProtocol } from "../src/protocol.js";
import type { VSBuffer } from "../src/buffer.js";

const PROMISE = 100;
const EVENT_LISTEN = 102;
const INITIALIZE = 200;
const PROMISE_SUCCESS = 201;
const PROMISE_ERROR = 202;
const PROMISE_ERROR_OBJ = 203;
const EVENT_FIRE = 204;
const NOTIFY = new Set([101, 103]);

function encoded(header: unknown[], body?: unknown): VSBuffer {
  const writer = new BufferWriter();
  serialize(writer, header);
  serialize(writer, body);
  return writer.buffer;
}

function headerOf(buffer: VSBuffer): any[] {
  const reader = new BufferReader(buffer);
  return deserialize(reader);
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Violation {
  seed: number;
  step: number;
  code: string;
  detail: string;
}

interface RequestModel {
  id: number;
  attempted: boolean;
  sent: boolean;
  notified: boolean;
  ended: boolean;
}

interface CallModel extends RequestModel {
  settled: number;
  outcomes: string[];
  usedToken: boolean;
}

interface CycleModel extends RequestModel {
  event: (listener: (value: string) => void) => IDisposable;
  handles: { disposable: IDisposable; removed: boolean; seen: number }[];
}

/**
 * fixture token 贴近真实 Emitter 语义：取消后新注册不再回调，
 * 但每次注册都要被释放一次，用于检查取消订阅句柄泄漏。
 */
function fixtureToken() {
  const listeners: (() => void)[] = [];
  const state = { registered: 0, released: 0, cancelled: false };
  const token = {
    get isCancellationRequested() {
      return state.cancelled;
    },
    onCancellationRequested(listener: () => void) {
      state.registered += 1;
      if (!state.cancelled) listeners.push(listener);
      return {
        dispose() {
          state.released += 1;
        },
      };
    },
  };
  return {
    token,
    state,
    cancel() {
      if (state.cancelled) return;
      state.cancelled = true;
      for (const listener of listeners.splice(0)) listener();
    },
  };
}

async function flush() {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

async function runCase(seed: number, violations: Violation[]) {
  const rnd = mulberry32(seed);
  const pick = (n: number) => Math.floor(rnd() * n);
  const note = (code: string, detail: string) => {
    if (violations.length < 40) violations.push({ seed, step, code, detail });
  };

  const input = new Emitter<VSBuffer>();
  const frames: { type: number; id: number }[] = [];
  const calls = new Map<number, CallModel>();
  const cycles = new Map<number, CycleModel>();
  const token = fixtureToken();

  let nextId = 0;
  let step = 0;
  let initialized = false;
  let sealed = false;
  let transportFailsLeft = 0;

  const table = () => (client as unknown as { requests: Map<number, unknown> }).requests;
  const expectedLive = () => {
    let live = 0;
    for (const call of calls.values()) if (!call.ended) live++;
    for (const cycle of cycles.values()) if (!cycle.ended) live++;
    return live;
  };
  const requestOf = (id: number): RequestModel | undefined => calls.get(id) ?? cycles.get(id);

  const protocol: IMessagePassingProtocol = {
    onMessage: input.event,
    send(data) {
      const header = headerOf(data);
      const type = header[0] as number;
      const id = header[1] as number;
      if (sealed) {
        note("frame-after-close", `type=${type} id=${id}`);
        return;
      }
      if (NOTIFY.has(type)) {
        const request = requestOf(id);
        if (!request) {
          note("notify-for-unknown-request", `type=${type} id=${id}`);
        } else if (!request.attempted) {
          note("notify-for-never-attempted-request", `type=${type} id=${id}`);
        } else if (request.notified) {
          note("duplicate-notify-frame", `type=${type} id=${id}`);
        } else {
          request.notified = true;
        }
        frames.push({ type, id });
        return;
      }
      const request = requestOf(id);
      if (!request || request.ended || request.sent) {
        note(
          type === PROMISE ? "promise-frame-for-invalid-call" : "listen-frame-for-invalid-cycle",
          `id=${id}`,
        );
        return;
      }
      request.attempted = true;
      if (transportFailsLeft > 0) {
        transportFailsLeft -= 1;
        request.ended = true;
        throw new Error("TRANSPORT_DOWN");
      }
      request.sent = true;
      frames.push({ type, id });
    },
  };

  const client = new ChannelClient(protocol);

  const deliveries = (cycle: CycleModel) => cycle.handles.reduce((sum, slot) => sum + slot.seen, 0);
  const attach = (cycle: CycleModel) => {
    const slot: { disposable: IDisposable; removed: boolean; seen: number } = {
      disposable: { dispose() {} },
      removed: false,
      seen: 0,
    };
    slot.disposable = cycle.event(() => {
      slot.seen += 1;
      if (slot.removed) note("listener-called-after-remove", `id=${cycle.id}`);
      if (cycle.ended) note("event-delivered-after-cycle-end", `id=${cycle.id}`);
    });
    cycle.handles.push(slot);
  };

  for (; step < 30; step++) {
    const op = pick(17);
    if (op === 0 || op === 1 || op === 2) {
      // 令牌已取消时客户端在分配 id 之前立即拒绝：不占 id、不入表、不发帧。
      if (token.state.cancelled) {
        const rejected = await client
          .getChannel("fixture")
          .call("work", undefined, token.token)
          .then(
            () => "fulfilled",
            (error: Error) => `rejected:${error.message}`,
          );
        if (rejected !== "rejected:Cancelled") {
          note("pre-cancelled-call-outcome", String(rejected));
        }
        continue;
      }
      const useToken = rnd() < 0.5;
      const id = nextId++;
      const record: CallModel = {
        id,
        attempted: false,
        sent: false,
        notified: false,
        ended: false,
        settled: 0,
        outcomes: [],
        usedToken: useToken,
      };
      calls.set(id, record);
      void client
        .getChannel("fixture")
        .call("work", undefined, useToken ? token.token : undefined)
        .then(
          (value) => {
            record.settled += 1;
            record.outcomes.push(`fulfilled:${String(value)}`);
          },
          (error: Error) => {
            record.settled += 1;
            record.outcomes.push(`rejected:${error.name || "Error"}`);
          },
        );
    } else if (op === 3 || op === 4) {
      const id = nextId++;
      const event = client.getChannel("fixture").listen<string>("tick");
      const cycle: CycleModel = {
        id,
        event,
        handles: [],
        attempted: false,
        sent: false,
        notified: false,
        ended: false,
      };
      cycles.set(id, cycle);
      attach(cycle);
    } else if (op === 5 || op === 6) {
      const live = [...cycles.values()].filter((cycle) => !cycle.ended);
      if (live.length === 0) continue;
      const cycle = live[pick(live.length)];
      if (cycle.handles.length > 0 && rnd() < 0.5) {
        const index = pick(cycle.handles.length);
        const slot = cycle.handles[index];
        slot.removed = true;
        slot.disposable.dispose();
        cycle.handles.splice(index, 1);
        if (cycle.handles.length === 0) cycle.ended = true;
      } else {
        attach(cycle);
      }
    } else if (op === 7) {
      input.fire(encoded([INITIALIZE]));
      initialized = true;
    } else if (op === 8 || op === 9) {
      const targets = [...cycles.values()];
      if (targets.length === 0) continue;
      const cycle = targets[pick(targets.length)];
      const before = deliveries(cycle);
      input.fire(encoded([EVENT_FIRE, cycle.id], `v${step}`));
      const expected = cycle.ended || !cycle.sent ? 0 : cycle.handles.length;
      if (deliveries(cycle) - before !== expected) {
        note(
          "fire-delivery-count-mismatch",
          `id=${cycle.id} got=${deliveries(cycle) - before} want=${expected}`,
        );
      }
    } else if (op === 10 || op === 11) {
      const targets = [...calls.values()];
      if (targets.length === 0) continue;
      const call = targets[pick(targets.length)];
      const kind = pick(3);
      const body =
        kind === 0
          ? "value"
          : kind === 1
            ? { message: "boom", name: "ServerSide", stack: undefined }
            : { reason: "raw" };
      const type = kind === 0 ? PROMISE_SUCCESS : kind === 1 ? PROMISE_ERROR : PROMISE_ERROR_OBJ;
      // 只有已上线且仍存活的请求会被客户端受理；其余回包必须被忽略。
      if (call.sent && !call.ended) call.ended = true;
      input.fire(encoded([type, call.id], body));
    } else if (op === 12) {
      token.cancel();
      for (const call of calls.values()) if (call.usedToken && !call.ended) call.ended = true;
    } else if (op === 13) {
      transportFailsLeft += 1 + pick(2);
    } else if (op === 14) {
      const live = [...cycles.values()].filter((cycle) => !cycle.ended);
      if (live.length === 0) continue;
      const cycle = live[pick(live.length)];
      for (const slot of cycle.handles.splice(0)) {
        slot.removed = true;
        slot.disposable.dispose();
      }
      cycle.ended = true;
    } else if (op === 15) {
      const live = [...calls.values()].filter((call) => !call.ended);
      if (live.length === 0) continue;
      const call = live[pick(live.length)];
      if (call.sent) call.ended = true;
      input.fire(encoded([PROMISE_ERROR_OBJ, call.id], { reason: "raw" }));
    } else {
      const ghost = nextId + 400;
      input.fire(encoded([EVENT_FIRE, ghost], "ghost"));
      input.fire(encoded([PROMISE_SUCCESS, ghost], "ghost"));
    }

    await flush();
    if (table().size !== expectedLive()) {
      note("live-table-mismatch", `table=${table().size} model=${expectedLive()}`);
    }
  }

  const liveSent =
    [...calls.values()].filter((call) => !call.ended && call.sent).length +
    [...cycles.values()].filter((cycle) => !cycle.ended && cycle.sent).length;
  const liveTotal = expectedLive();
  const framesBeforeClose = frames.length;
  if (table().size !== liveTotal) {
    note("table-before-close-mismatch", `table=${table().size} model=${liveTotal}`);
  }
  client.dispose();
  const drained = frames.length - framesBeforeClose;
  const drainedNotify = frames
    .slice(framesBeforeClose)
    .filter((frame) => NOTIFY.has(frame.type)).length;
  if (drainedNotify !== liveSent) {
    note("close-notify-count-mismatch", `got=${drainedNotify} want=${liveSent}`);
  }
  if (drained !== liveSent) {
    note("close-emits-extra-frames", `extra=${drained} want=${liveSent}`);
  }
  if (table().size !== 0) note("table-not-drained-on-close", `size=${table().size}`);
  // 从这里起任何新帧都属于终结之后的迟到写入。
  sealed = true;
  await flush();
  if (frames.length !== framesBeforeClose + drained) {
    const tail = frames
      .slice(framesBeforeClose + drained)
      .map((frame) => `${frame.type}/${frame.id}`)
      .join(",");
    note("frame-after-close", `late=[${tail}]`);
  }
  client.dispose();

  if (token.state.registered !== token.state.released) {
    note(
      "cancellation-handle-leak",
      `registered=${token.state.registered} released=${token.state.released}`,
    );
  }
  for (const call of calls.values()) {
    if (call.settled !== 1) note("call-settled-count", `id=${call.id} settled=${call.settled}`);
  }
  for (const cycle of cycles.values()) {
    if (!cycle.ended && initialized && !cycle.sent) {
      note("live-cycle-never-dispatched", `id=${cycle.id}`);
    }
  }
}

test("随机操作序列下通道客户端维持唯一表、通知帧与投递不变量", async () => {
  const violations: Violation[] = [];
  const seeds = Array.from({ length: 80 }, (_, index) => 1000 + index * 7919);
  for (const seed of seeds) await runCase(seed, violations);
  if (violations.length > 0) {
    const summary = violations
      .slice(0, 15)
      .map((item) => `${item.code} seed=${item.seed} step=${item.step} ${item.detail}`)
      .join("\n");
    assert.fail(`invariant violations:\n${summary}`);
  }
  assert.equal(violations.length, 0);
});

test("握手前排队的请求按创建顺序上线，监听在事件回调中撤销自己只退订一次", async () => {
  const input = new Emitter<VSBuffer>();
  const frames: { type: number; id: number }[] = [];
  const protocol: IMessagePassingProtocol = {
    onMessage: input.event,
    send(data) {
      const header = headerOf(data);
      frames.push({ type: header[0], id: header[1] });
    },
  };
  const client = new ChannelClient(protocol);

  // 未握手时先排两个请求，验证 Initialize 批次维持插入顺序。
  const first = client.getChannel("fixture").call("first");
  void first.then(
    () => undefined,
    () => undefined,
  );
  let hits = 0;
  const event = client.getChannel("fixture").listen<string>("tick");
  const subscription = event(() => {
    hits += 1;
    // 真实消费方常见形态：收到事件后撤销自己。
    subscription.dispose();
  });
  input.fire(encoded([INITIALIZE]));
  const late = client.getChannel("fixture").call("late");
  void late.then(
    () => undefined,
    () => undefined,
  );
  await flush();

  const requestFrames = frames.filter(
    (frame) => frame.type === PROMISE || frame.type === EVENT_LISTEN,
  );
  assert.equal(requestFrames.length, 3, "每个请求恰好上线一次，无重复帧");
  assert.deepEqual(
    new Set(requestFrames.map((frame) => frame.id)).size,
    3,
    "三个请求使用互不重复的 id",
  );
  // 握手前排队的两项走微任务批次，实测批次内部保持创建顺序；
  // 同一 tick 内握手之后新建的请求会抢先同步发送，协议本身不承诺跨请求顺序，
  // 因此这里只锁定"批次内有序 + 每请求一帧"，不把抢先写成缺陷。
  const queued = requestFrames.filter((frame) => frame.id === 0 || frame.id === 1);
  assert.deepEqual(
    queued.map((frame) => frame.id),
    [0, 1],
    "Initialize 批次内部保持原插入顺序",
  );
  assert.deepEqual(
    requestFrames.map((frame) => frame.type),
    [PROMISE, PROMISE, EVENT_LISTEN],
    "握手后同 tick 新建的调用抢先同步上线，排队的两项随后按序补发",
  );

  // 撤销自己之后：本轮已投递一次，后续事件不得再投递，也不得补发第二帧退订。
  const listenId = requestFrames.find((frame) => frame.type === EVENT_LISTEN)?.id;
  assert.notEqual(listenId, undefined, "事件订阅已上线");
  const beforeDisposes = frames.filter((frame) => frame.type === 103).length;
  input.fire(encoded([EVENT_FIRE, listenId], "a"));
  input.fire(encoded([EVENT_FIRE, listenId], "b"));
  assert.equal(hits, 1, "回调内撤销后同一订阅周期不再收事件");
  assert.equal(
    frames.filter((frame) => frame.type === 103).length,
    beforeDisposes + 1,
    "最后监听离开只发一帧 EventDispose",
  );
  input.fire(encoded([EVENT_FIRE, listenId], "c"));
  assert.equal(hits, 1, "退订后的迟到事件被丢弃");

  client.dispose();
  await flush();
  assert.equal(
    (client as unknown as { requests: Map<number, unknown> }).requests.size,
    0,
    "断开后唯一表归零",
  );
});

test("事件回调撤销全部监听后周期结束，之后重新订阅走新周期", () => {
  const input = new Emitter<VSBuffer>();
  const frames: { type: number; id: number }[] = [];
  const client = new ChannelClient({
    onMessage: input.event,
    send(data) {
      const header = headerOf(data);
      frames.push({ type: header[0], id: header[1] });
    },
  });
  input.fire(encoded([INITIALIZE]));
  const event = client.getChannel("fixture").listen<string>("tick");
  const seen: string[] = [];
  let second: IDisposable | undefined;
  const first = event((value) => {
    seen.push(`first:${value}`);
    second?.dispose();
  });
  second = event((value) => {
    seen.push(`second:${value}`);
  });
  const listenId = frames[0].id;
  input.fire(encoded([EVENT_FIRE, listenId], "x"));
  assert.deepEqual(seen, ["first:x", "second:x"], "同一轮事件按快照投递给当时在册的每个监听");
  assert.equal(frames.filter((frame) => frame.type === 103).length, 0, "仍有监听时不得退订");
  first.dispose();
  assert.deepEqual(frames.map((frame) => frame.type).slice(1), [103], "最后一个监听离开才退订一次");
  // 周期结束后同一个 Event 仍可重订，但必须走新的请求 id。
  const again = event(() => seen.push("again"));
  assert.equal(frames.length, 3);
  assert.equal(frames[2].type, EVENT_LISTEN);
  assert.notEqual(frames[2].id, listenId, "重订分配新周期 id");
  input.fire(encoded([EVENT_FIRE, frames[2].id], "y"));
  assert.deepEqual(seen, ["first:x", "second:x", "again"], "新周期独立收事件");
  input.fire(encoded([EVENT_FIRE, listenId], "ghost"));
  assert.deepEqual(seen, ["first:x", "second:x", "again"], "旧周期 id 的迟到事件被丢弃");
  again.dispose();
  assert.equal((client as unknown as { requests: Map<number, unknown> }).requests.size, 0);
  client.dispose();
});
