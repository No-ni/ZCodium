/**
 * DelayedChannel 订阅周期所有权回归（纯内存 node:test，直接导入真实 TS 导出）。
 *
 * 规格依据 docs/specs/rpc-delayed-channel-subscription.md：
 * - 未订阅时完全不触碰上游；首个本地监听者到来才激活，且只建立一次上游订阅；
 * - 最后一个本地监听者离开即释放上游订阅并停止收流；退订后重订只新建一次；
 * - 终态之后到达的 promise 结果只能丢弃，不得重建上游订阅；
 * - 旧周期迟到的成功结果不得夺走当前周期的订阅槽位，迟到的失败只终结自己，
 *   两者都不得让刚重订的新周期失去释放能力或结束它的本地 Event；
 * - promise 拒绝或上游 channel.listen 抛错都走同一终结路径：禁止游离 unhandledRejection、
 *   不留活订阅、不留半初始化周期；
 * - 上游 disposer 抛错只被吞掉：终态照常落地、不逃逸到调用方退订路径、不阻断后续周期；
 * - 句柄登记前后各核对一次终态：同步退订后的迟到句柄立即释放，已终结周期不得向本地 Event
 *   投递；非合作上游补投在途帧时，也不得把同一帧重复投给刚重订的新周期；
 * - 真实 ChannelClient/ChannelServer 链路上，退订后两侧请求表归零且不再产出 EventFire 帧；
 * - call 的拒绝仍回调用方。
 *
 * 不使用真实 socket、不引入 Vitest（与既有 RPC 生命周期 Vitest 用例互补）。
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { VSBuffer } from "../src/buffer.js";
import { ChannelClient } from "../src/channelClient.js";
import { ChannelServer } from "../src/channelServer.js";
import { getDelayedChannel } from "../src/delayedChannel.js";
import type { IChannel } from "../src/channels.shared.js";
import { Emitter, toDisposable, type Event, type IDisposable } from "../src/foundation.js";
import type { IMessagePassingProtocol } from "../src/protocol.js";

/** 排空微任务与若干轮宏任务，保证 wire 往返与订阅登记完成。 */
async function settle(rounds = 4): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await Promise.resolve();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

/**
 * 计数用的上游 channel：记录被订阅次数与当前存活监听数，并按场景注入真实链路上
 * 可能出现的非合作行为（disposer 抛错、句柄返回前同步投递、释放后仍补投在途帧）。
 */
function countingChannel(
  options: {
    throwOnListen?: boolean;
    /** 上游退订句柄 dispose 抛错：验证外部 disposer 不阻断终态、不逃逸到退订路径。 */
    throwOnDispose?: boolean;
    /** 每次订阅建立时都同步投递这些值：模拟句柄返回给本模块之前上游已回调本地监听者。 */
    fireOnSubscribe?: unknown[];
    /** 非合作上游：释放句柄后仍继续回调该监听者，对应已在路上的 EventFire 帧。 */
    keepDeliveringAfterDispose?: boolean;
  } = {},
): {
  channel: IChannel;
  fire: (value: unknown) => void;
  subscriptionCount: () => number;
  liveCount: () => number;
} {
  // 用 any 对齐 IChannel 的泛型方法签名：listen 的返回类型由调用方推断，
  // 写成 Event<unknown> 会无法赋值给 <T>(...) => Event<T>。
  const source = new Emitter<any>();
  let subscriptions = 0;
  let live = 0;
  const channel: IChannel = {
    async call(): Promise<any> {
      return "pong";
    },
    listen(): Event<any> {
      if (options.throwOnListen) {
        throw new Error("upstream listen rejected");
      }
      subscriptions += 1;
      return (listener) => {
        live += 1;
        const disposable = source.event(listener);
        if (options.fireOnSubscribe) {
          // 每次订阅都在 handle 返回给本模块之前同步投递：此刻只能靠终态守卫与登记前的二次核对兜住。
          for (const value of options.fireOnSubscribe) {
            listener(value);
          }
        }
        return toDisposable(() => {
          live -= 1;
          if (!options.keepDeliveringAfterDispose) {
            disposable.dispose();
          }
          if (options.throwOnDispose) {
            throw new Error("upstream disposer rejected");
          }
        });
      };
    },
  };
  return {
    channel,
    fire: (value) => source.fire(value),
    subscriptionCount: () => subscriptions,
    liveCount: () => live,
  };
}

/** 只在断言游离 rejection 的用例里临时安装，禁止污染进程级默认行为。 */
async function withRejectionCapture<T>(
  run: () => Promise<T>,
): Promise<{ result: T; rejections: string[] }> {
  const rejections: string[] = [];
  const listener = (reason: unknown) => {
    rejections.push(reason instanceof Error ? reason.message : String(reason));
  };
  process.prependListener("unhandledRejection", listener);
  try {
    const result = await run();
    // 游离 rejection 在下一个宏任务才上报，必须多等一轮再判定。
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    return { result, rejections };
  } finally {
    process.removeListener("unhandledRejection", listener);
  }
}

function requestTableSize(owner: object): number {
  return (owner as unknown as { requests: Map<number, unknown> }).requests.size;
}

/** 与 protocol.ts createQueuePair 同构的内存协议对：投递在宏任务里发生。 */
function memoryProtocolPair(): {
  clientProtocol: IMessagePassingProtocol;
  serverProtocol: IMessagePassingProtocol;
  serverFrames: () => number;
} {
  const toClient = new Emitter<VSBuffer>();
  const toServer = new Emitter<VSBuffer>();
  let serverSent = 0;
  const clientProtocol: IMessagePassingProtocol = {
    onMessage: toClient.event,
    send: (buffer) => {
      setTimeout(() => toServer.fire(buffer), 0);
    },
  };
  const serverProtocol: IMessagePassingProtocol = {
    onMessage: toServer.event,
    send: (buffer) => {
      serverSent += 1;
      setTimeout(() => toClient.fire(buffer), 0);
    },
  };
  return { clientProtocol, serverProtocol, serverFrames: () => serverSent };
}

test("未订阅时不触碰上游，首个本地监听者到来才建立唯一一次订阅", async () => {
  const upstream = countingChannel();
  const event = getDelayedChannel(Promise.resolve(upstream.channel)).listen("onTick");
  await settle();
  assert.equal(upstream.subscriptionCount(), 0, "没有监听者时不得订阅上游");
  assert.equal(upstream.liveCount(), 0);

  const received: unknown[] = [];
  const subscription = event((value) => received.push(value));
  await settle();
  assert.equal(upstream.subscriptionCount(), 1, "首个监听者只触发一次上游订阅");
  assert.equal(upstream.liveCount(), 1);

  upstream.fire("first");
  await settle();
  assert.deepEqual(received, ["first"]);
  subscription.dispose();
});

test("最后一个本地监听者离开后释放上游订阅并停止收流", async () => {
  const upstream = countingChannel();
  const event = getDelayedChannel(Promise.resolve(upstream.channel)).listen("onTick");
  const received: unknown[] = [];
  const subscription = event((value) => received.push(value));
  await settle();
  assert.equal(upstream.liveCount(), 1);

  // 退订必须回收上游监听：否则对端会一直为这条已无人监听的订阅推流。
  subscription.dispose();
  await settle();
  assert.equal(upstream.liveCount(), 0, "最后监听者离开后上游存活监听必须归零");

  upstream.fire("late-after-dispose");
  await settle();
  assert.deepEqual(received, [], "退订后不得再向该监听者投递");
});

test("退订后重新监听只新建一次上游订阅", async () => {
  const upstream = countingChannel();
  const event = getDelayedChannel(Promise.resolve(upstream.channel)).listen("onTick");
  const first = event(() => {});
  await settle();
  first.dispose();
  await settle();
  assert.equal(upstream.liveCount(), 0);

  const received: unknown[] = [];
  const second = event((value) => received.push(value));
  await settle();
  assert.equal(upstream.subscriptionCount(), 2, "重订只允许新增一次上游订阅");
  assert.equal(upstream.liveCount(), 1, "重订后只允许一条存活订阅");

  upstream.fire("resubscribed");
  await settle();
  assert.deepEqual(received, ["resubscribed"]);
  second.dispose();
  await settle();
  assert.equal(upstream.liveCount(), 0);
});

test("周期结束后的迟到 promise 结果不得重建上游订阅", async () => {
  const upstream = countingChannel();
  let resolveChannel: ((channel: IChannel) => void) | undefined;
  const pending = new Promise<IChannel>((resolve) => {
    resolveChannel = resolve;
  });
  const event = getDelayedChannel(pending).listen("onTick");
  const subscription = event(() => {});
  await settle();
  assert.equal(upstream.subscriptionCount(), 0, "promise 未解析前不得订阅上游");

  // 结果到达前消费者已全部离开：这个周期已进入终态。
  subscription.dispose();
  await settle();
  resolveChannel?.(upstream.channel);
  await settle();
  assert.equal(upstream.subscriptionCount(), 0, "终态后的迟到结果不得建立上游订阅");
  assert.equal(upstream.liveCount(), 0);
});

test("旧周期迟到的成功结果不得夺走当前周期的订阅槽位", async () => {
  const upstream = countingChannel();
  let resolveChannel: ((channel: IChannel) => void) | undefined;
  const pending = new Promise<IChannel>((resolve) => {
    resolveChannel = resolve;
  });
  const event = getDelayedChannel(pending).listen("onTick");
  const first = event(() => {});
  await settle();
  // 结果到达前全部离开：旧周期进入终态，但它的 .then 仍排在新周期激活之后执行。
  first.dispose();
  await settle();

  const second = event(() => {});
  await settle();
  assert.equal(upstream.subscriptionCount(), 0, "promise 未解析前新周期同样不得订阅上游");

  resolveChannel?.(upstream.channel);
  await settle();
  assert.equal(upstream.subscriptionCount(), 1, "只有当前周期允许建立一次上游订阅");
  assert.equal(upstream.liveCount(), 1);

  // 旧周期完成时若把当前槽位一并清掉，新周期最后监听者离开就无人释放上游，
  // 直接退回本轮要修的泄漏形态，所以这一步才是本用例的判别点。
  second.dispose();
  await settle();
  assert.equal(upstream.liveCount(), 0, "旧周期迟到结果不得让新周期失去释放能力");
});

test("旧周期迟到的失败只终结自己，不得结束刚重订的新周期", async () => {
  // 判别点：旧周期必须真的执行过 channel.listen 才抛错，它的 .catch 才会排到新周期激活之后。
  // 若让退订发生在 promise 解析之前，旧周期连 channel.listen 都不会调用，本用例就退化成
  // 「迟到结果不重建」，测不到旧/新周期并存时的失败终结范围。
  const source = new Emitter<any>();
  const received: unknown[] = [];
  let listenAttempts = 0;
  let liveUpstream = 0;
  let event: Event<any> | undefined;
  let first: IDisposable | undefined;
  let second: IDisposable | undefined;

  const channel: IChannel = {
    async call(): Promise<any> {
      return "pong";
    },
    listen(): Event<any> {
      listenAttempts += 1;
      if (listenAttempts === 1) {
        // 外部代码在 channel.listen 内同步重入：最后一个旧监听者离开、新的首个监听者立刻到来，
        // 然后才抛错，于是旧周期的失败回调排在新周期订阅成功之后。
        first?.dispose();
        second = event?.((value) => received.push(value));
        throw new Error("upstream listen rejected");
      }
      return (listener) => {
        liveUpstream += 1;
        const disposable = source.event(listener);
        return toDisposable(() => {
          liveUpstream -= 1;
          disposable.dispose();
        });
      };
    },
  };

  event = getDelayedChannel(Promise.resolve(channel)).listen("onTick");
  first = event(() => {});
  await settle();

  assert.equal(listenAttempts, 2, "旧周期一次失败尝试加新周期一次成功订阅");
  assert.ok(second, "旧周期的外部重入回调里应已建立新周期");
  assert.equal(liveUpstream, 1, "旧周期失败不得留下第二条存活订阅");

  source.fire("fresh");
  await settle();
  assert.deepEqual(received, ["fresh"], "旧周期的迟到失败不得结束新周期的本地 Event");

  second.dispose();
  await settle();
  assert.equal(liveUpstream, 0, "新周期仍能按最后一个本地监听者离开释放上游");
});

test("上游 disposer 抛错不阻断终态、不逃逸到退订路径、不污染后续周期", async () => {
  const upstream = countingChannel({ throwOnDispose: true });
  const event = getDelayedChannel(Promise.resolve(upstream.channel)).listen("onTick");
  const received: unknown[] = [];
  const subscription = event((value) => received.push(value));
  await settle();
  assert.equal(upstream.liveCount(), 1);
  upstream.fire("before");
  await settle();
  assert.deepEqual(received, ["before"]);

  // 故意不包 try/catch：外部 disposer 的异常若逃逸到这条退订路径就是缺陷。
  subscription.dispose();
  await settle();
  assert.equal(upstream.liveCount(), 0, "抛错之前终态与唯一句柄回收必须已经落地");

  upstream.fire("after");
  await settle();
  assert.deepEqual(received, ["before"], "退订后不得再向该监听者投递");

  const second = event(() => {});
  await settle();
  assert.equal(upstream.subscriptionCount(), 2, "上一周期的 disposer 抛错不得阻断重订");
  assert.equal(upstream.liveCount(), 1);
  second.dispose();
  await settle();
  assert.equal(upstream.liveCount(), 0);
});

test("同步退订后的迟到句柄立即释放，不复活已终结周期", async () => {
  // throwOnDispose 让这条迟到句柄的 dispose() 也抛错：覆盖「登记前二次核对」分支里独立的那条 catch。
  const upstream = countingChannel({
    fireOnSubscribe: ["late-frame", "second-late-frame"],
    throwOnDispose: true,
  });
  const event = getDelayedChannel(Promise.resolve(upstream.channel)).listen("onTick");
  const received: unknown[] = [];
  let disposeSelf: (() => void) | undefined;
  let armed = true;
  const subscription = event((value) => {
    received.push(value);
    if (armed) {
      armed = false;
      // 首帧到达即退订：此时上游句柄还没回到本模块，终态必须先落地。
      disposeSelf?.();
    }
  });
  disposeSelf = () => subscription.dispose();
  await settle();

  assert.equal(upstream.subscriptionCount(), 1);
  assert.equal(upstream.liveCount(), 0, "登记前核对到终态必须立即释放迟到句柄");
  assert.deepEqual(received, ["late-frame"], "已终结周期不得继续向本地 Event 投递");

  // 重订后的新周期是健康周期：它同样要能承接上游的同步投递，之后再追加异步投递也必须只到一次。
  const resubscribed: unknown[] = [];
  const second = event((value) => resubscribed.push(value));
  await settle();
  assert.equal(upstream.subscriptionCount(), 2);
  assert.equal(upstream.liveCount(), 1);
  assert.deepEqual(
    resubscribed,
    ["late-frame", "second-late-frame"],
    "新周期必须收到上游在句柄返回前的同步投递",
  );
  upstream.fire("after-resubscribe");
  await settle();
  assert.deepEqual(
    resubscribed,
    ["late-frame", "second-late-frame", "after-resubscribe"],
    "本地 Event 不得被那条已终结周期结束，新周期仍能继续收流",
  );
  second.dispose();
  await settle();
  assert.equal(upstream.liveCount(), 0);
});

test("非合作上游补投在途帧时，已终结周期不得向新周期重复投递", async () => {
  // 释放句柄后上游仍继续回调旧监听者，对应 EventDispose 只是异步消息、帧已在路上的真实形态。
  const upstream = countingChannel({ keepDeliveringAfterDispose: true });
  const event = getDelayedChannel(Promise.resolve(upstream.channel)).listen("onTick");
  const received: unknown[] = [];
  const first = event(() => {});
  await settle();
  first.dispose();
  const second = event((value) => received.push(value));
  await settle();
  assert.equal(upstream.subscriptionCount(), 2);
  assert.equal(upstream.liveCount(), 1);

  upstream.fire("one-frame");
  await settle();
  // 同一帧会同时到达旧周期与新周期的回调，旧周期必须被终态守卫挡下，本地 Event 只收到一次。
  assert.deepEqual(received, ["one-frame"], "已终结周期不得把同一帧重复投给刚重订的新周期");

  second.dispose();
  await settle();
  assert.equal(upstream.liveCount(), 0);
});

test("promise 拒绝不产生游离 rejection，也不留下活订阅", async () => {
  const upstream = countingChannel();
  // 显式标注类型：Promise.reject 会被推断成 Promise<never>，导致 getDelayedChannel 的 T 塌成 never。
  const rejected: Promise<IChannel> = Promise.reject(new Error("route rejected"));
  const { rejections } = await withRejectionCapture(async () => {
    const event = getDelayedChannel(rejected).listen("onTick");
    const subscription = event(() => {});
    await settle();
    return subscription;
  });
  assert.deepEqual(
    rejections,
    [],
    "路由拒绝必须由本周期终结路径消费，禁止逃逸为 unhandledRejection",
  );
  assert.equal(upstream.liveCount(), 0, "拒绝后不得留下任何上游订阅");
  assert.equal(upstream.subscriptionCount(), 0);
});

test("上游 channel.listen 抛错不产生游离 rejection 且不留半初始化周期", async () => {
  const upstream = countingChannel({ throwOnListen: true });
  const { rejections } = await withRejectionCapture(async () => {
    const event = getDelayedChannel(Promise.resolve(upstream.channel)).listen("onTick");
    const subscription = event(() => {});
    await settle();
    return subscription;
  });
  assert.deepEqual(rejections, [], "上游同步抛错同样必须被终结路径消费");
  assert.equal(upstream.liveCount(), 0);
});

test("多监听者时只有最后一个离开才释放上游订阅", async () => {
  const upstream = countingChannel();
  const event = getDelayedChannel(Promise.resolve(upstream.channel)).listen("onTick");
  const a: unknown[] = [];
  const b: unknown[] = [];
  // 两个不同的监听函数共享同一个延迟周期，只允许一条上游订阅。
  const subscriptionA = event((value) => a.push(value));
  const subscriptionB = event((value) => b.push(value));
  await settle();
  assert.equal(upstream.subscriptionCount(), 1, "同一周期内多个监听者不得重复订阅上游");
  assert.equal(upstream.liveCount(), 1);

  subscriptionA.dispose();
  upstream.fire("still-listening");
  await settle();
  assert.equal(upstream.liveCount(), 1, "仍有监听者时不得提前释放上游订阅");
  assert.deepEqual(b, ["still-listening"]);

  subscriptionB.dispose();
  await settle();
  assert.equal(upstream.liveCount(), 0);
});

test("真实 ChannelClient/ChannelServer：退订后两侧请求表归零且停止产出 EventFire 帧", async () => {
  const { clientProtocol, serverProtocol, serverFrames } = memoryProtocolPair();
  const client = new ChannelClient(clientProtocol);
  const server = new ChannelServer(serverProtocol, "fixture", 1000, false);
  const source = new Emitter<any>();
  server.registerChannel("svc", {
    // any 对齐 IServerChannel.call<T> 的泛型签名。
    call: async (): Promise<any> => "pong",
    listen: () => source.event,
  });
  await settle();

  const delayed = getDelayedChannel(Promise.resolve(client.getChannel("svc"))).listen("onTick");
  const subscription = delayed(() => {});
  await settle();
  assert.equal(requestTableSize(client), 1, "订阅期间客户端请求表登记一条 EventListen");
  assert.equal(requestTableSize(server), 1, "订阅期间服务端请求表登记一条 EventListen");

  // 消费者退订必须让两侧表归零：残留记录会让对端持续为该订阅编码并发送帧。
  subscription.dispose();
  await settle();
  assert.equal(requestTableSize(client), 0, "退订后客户端请求表必须归零");
  assert.equal(requestTableSize(server), 0, "退订后服务端请求表必须归零");

  const framesAfterDispose = serverFrames();
  for (let index = 0; index < 5; index += 1) {
    source.fire("leak-check-" + index);
  }
  await settle();
  assert.equal(serverFrames(), framesAfterDispose, "退订后服务端不得再产出事件帧");

  client.dispose();
  server.dispose();
  source.dispose();
});

test("call 的拒绝仍然回给调用方", async () => {
  const boom = new Error("call route rejected");
  const rejectedCall: Promise<IChannel> = Promise.reject(boom);
  const delayed = getDelayedChannel(rejectedCall);
  const { result, rejections } = await withRejectionCapture(async () => {
    try {
      await delayed.call("work");
      return "resolved";
    } catch (error) {
      return (error as Error).message;
    }
  });
  assert.equal(result, "call route rejected", "call 路径必须把拒绝原样交给调用方");
  assert.deepEqual(rejections, [], "call 路径不得额外制造游离 rejection");
});

test("只构造、既不 call 也不 listen 时，源 promise 的拒绝也不产生游离 rejection", async () => {
  const { rejections } = await withRejectionCapture(async () => {
    // 对齐真实形态：IPCServer.getChannel(name, router) 的路由 promise 先于方法使用产生，
    // 连接关闭或路由失败时这个延迟通道可能从未被 call/listen 就废弃。
    const rejected: Promise<IChannel> = Promise.reject(new Error("route rejected before any use"));
    getDelayedChannel(rejected);
    await settle();
  });
  assert.deepEqual(
    rejections,
    [],
    "源 promise 的终态必须在构造期就被消费，禁止游离 unhandledRejection",
  );
});
