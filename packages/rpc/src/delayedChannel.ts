import { type CancellationToken, type IDisposable, Event, Emitter } from "./foundation.js";
import type { IChannel } from "./channels.shared.js";

/**
 * 一个延迟订阅周期的唯一状态：是否已终结，以及至多一个上游订阅句柄。
 * 该对象只由下面 listen 闭包里的 active 变量拥有，调用方持有的退订句柄不另存第二份登记。
 */
interface DelayedCycle {
  released: boolean;
  upstream?: IDisposable;
}

export function getDelayedChannel<T extends IChannel>(promise: Promise<T>): T {
  // 修复依据：原实现每次 listen 都新建一个对外不可达的 Relay，调用方退订后 relay.input 建立的
  // 上游订阅永不释放——真实链路上表现为 ChannelClient 的 EventListen 记录不归零、服务端继续为
  // 这条无人监听的订阅编码并发送 EventFire 帧，且每调用一次 listen 就累积一条不可回收周期；
  // 同时 promise.then 没有拒绝分支，路由失败会逃逸成游离 unhandledRejection，订阅侧永远静默。
  // 现在由本闭包担任唯一 owner：首个本地监听者到来才订阅上游，最后一个监听者离开即释放，
  // 终态后到达的结果只丢弃不重建，拒绝与上游同步抛错都走同一终结入口。
  // 契约见 docs/specs/rpc-delayed-channel-subscription.md；不改动通用 Emitter/Relay 语义，
  // 不新增 wire 类型或事件错误响应，不在此记录任何错误原文。
  // 构造期就消费源 promise 的终态，只记录结果、不建立订阅，并且整个延迟通道只创建这一份：
  // 调用方常常在任何 call/listen 之前就已持有该 promise（IPCServer.getChannel(name, router) 的路由
  // promise 先于方法使用产生，连接关闭或路由失败后通道可能直接废弃），若把消费者放在 listen 内部，
  // 只构造不监听的用法仍会让拒绝逃逸为游离 unhandledRejection。订阅动作依旧只在首个本地监听者
  // 到来时发生，未订阅时完全不触碰上游；call 不使用这里的结果，仍从源 promise 传递拒绝给调用方。
  const settled: Promise<{ channel: T | undefined }> = promise.then(
    (channel) => ({ channel }),
    // 拒绝在这里被消费；是否结束本地订阅周期由激活路径按当时状态判定。
    () => ({ channel: undefined }),
  );

  return {
    call(command: string, arg?: any, cancellationToken?: CancellationToken): Promise<any> {
      // 对外语义不变：拒绝仍原样回给调用方，不被构造期消费者吞掉。
      return promise.then((channel) => channel.call(command, arg, cancellationToken));
    },
    listen(event: string, arg?: any): Event<any> {
      let active: DelayedCycle | undefined;

      /** 唯一释放入口：先写不可逆终态，再回收唯一上游句柄；可选结束本地 Event。 */
      const release = (cycle: DelayedCycle, terminateLocal: boolean): void => {
        const isCurrent = active === cycle;
        if (isCurrent) active = undefined;
        if (!cycle.released) {
          // 终态必须先写入：外部 disposer 或上游回调同步重入时不能再复活这条订阅。
          cycle.released = true;
          const upstream = cycle.upstream;
          cycle.upstream = undefined;
          try {
            upstream?.dispose();
          } catch {
            // 单个外部 disposer 抛错不得阻断终态，也不得逃逸到调用方的退订路径。
          }
        }
        // 只有仍在前台的周期失败才结束本地 Event：旧周期的迟到失败不得杀掉刚重订的新周期。
        if (terminateLocal && isCurrent) emitter.dispose();
      };

      const emitter = new Emitter<any>({
        onWillAddFirstListener: () => {
          const cycle: DelayedCycle = { released: false };
          active = cycle;
          void settled
            .then(({ channel }) => {
              // 结果到达前消费者可能已全部离开：终态周期不得再建立上游订阅；
              // 路由拒绝在这里表现为没有可用 channel，与拒绝走同一终结入口。
              if (!channel || cycle.released) {
                release(cycle, true);
                return;
              }
              // channel.listen 可执行外部代码并同步触发退订，因此句柄登记前后各核对一次终态。
              const upstreamEvent = channel.listen(event, arg);
              const handle = upstreamEvent((data) => {
                if (cycle.released) return;
                emitter.fire(data);
              });
              if (cycle.released) {
                try {
                  handle.dispose();
                } catch {
                  // 迟到句柄释放失败也不得复活已终结的周期。
                }
                return;
              }
              cycle.upstream = handle;
            })
            .catch(() => {
              // 上游订阅/投递过程中的外部异常在此收敛：不留半初始化句柄、不逃逸为游离 rejection，
              // 也不在此输出错误原文（协议没有事件错误响应类型）。
              release(cycle, true);
            });
        },
        onDidRemoveLastListener: () => {
          const cycle = active;
          if (cycle) release(cycle, false);
        },
      });
      return emitter.event;
    },
  } as T;
}
