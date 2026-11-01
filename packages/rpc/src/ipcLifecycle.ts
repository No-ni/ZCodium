/**
 * IPC 私有生命周期 helper：连接 scope 与未路由调用的路由等待。
 *
 * 规格依据：
 * - docs/specs/rpc-connection-ownership.md「IPCServer 公开框架连接 scope」
 * - docs/specs/rpc-client-lifecycle.md「IPCServer 未路由调用的所有权」
 *
 * 设计要点：
 * - 每条连接从握手起由唯一 scope 拥有：先安装 disconnect 再等第一条身份消息，
 *   握手前断开、初始化发送中关闭、add 回调重入关闭都不会遗留 ghost 连接；
 * - scope 关闭不可逆且幂等：摘除 owner 登记 → 解绑本次注册的监听 →
 *   释放已建通道资源 → 对已接纳连接通知一次 remove；外部协议不归 scope 所有；
 * - 未路由调用等待项由 IPCServer 统一登记（唯一 owner），路由阶段持有独立阶段取消源：
 *   用户取消联动、server dispose 主动 cancel、正常选中只 dispose 不 cancel；
 * - 所有监听由统一 finish 解除，不使用 timeout 或残留监听的 Promise.race。
 *
 * 本文件是 packages/rpc 的私有实现，不进入 index.ts 公开导出；
 * 仅依赖 foundation 的 Event/IDisposable/CancellationTokenSource 与本地序列化，
 * 不引入业务、IO、持久状态或桌面/mobile 重放语义。
 */

import type { VSBuffer } from "./buffer.js";
import type { ChannelClient, ChannelServer } from "./channels.js";
import type { IServerChannel } from "./channels.shared.js";
import {
  CancellationTokenSource,
  Event,
  type CancellationToken,
  type IDisposable,
} from "./foundation.js";
import type { IMessagePassingProtocol } from "./protocol.js";
import { BufferReader, deserialize } from "./serialization.js";

/** 外部释放回调可能抛错，但不得阻断本方终态的其余清理和 promise settle。 */
export function disposeIpcResource(resource: IDisposable): void {
  try {
    resource.dispose();
  } catch {
    // 所有权已摘除；继续释放其它本地资源，不记录可能携带业务数据的外部错误。
  }
}

/** IPCServer 内部连接视图成员：客户端标识 + 本 scope 持有的双向通道。 */
export interface IpcConnection<TContext> {
  readonly ctx: TContext;
  readonly channelServer: ChannelServer<TContext>;
  readonly channelClient: ChannelClient;
}

/** IpcConnectionScope 回写 IPCServer 的最小协作接口。 */
export interface IpcConnectionScopeOwner<TContext> {
  /** 服务端初始化发送可同步关闭；每个资源取得后须先登记并检查终态。 */
  createChannelServer(protocol: IMessagePassingProtocol, ctx: TContext): ChannelServer<TContext>;
  createChannelClient(protocol: IMessagePassingProtocol): ChannelClient;
  /** 把当前已注册 channel 推送给新连接。 */
  forEachRegisteredChannel(fn: (name: string, channel: IServerChannel<TContext>) => void): void;
  /** 接纳连接：进入派生活跃视图并对外通知 add；回调内可能同步重入关闭。 */
  acceptConnection(connection: IpcConnection<TContext>): void;
  /** 对已接纳连接对外通知一次 remove。 */
  notifyRemoved(connection: IpcConnection<TContext>): void;
  /** 从 owner 集合摘除本 scope。 */
  removeScope(scope: IpcConnectionScope<TContext>): void;
}

/**
 * 单条连接的独占 scope：从等待 ctx 起拥有连接，直到断开或被终结。
 * 只有本 scope 能接纳、终结该连接；scope 只解绑自己注册的监听，不 dispose 外部协议。
 */
export class IpcConnectionScope<TContext> implements IDisposable {
  private closed = false;
  private accepted: IpcConnection<TContext> | undefined;
  // 监听与通道仅由这一资源列表拥有；accepted 只是派生连接视图，不重复释放通道。
  private readonly resources: IDisposable[] = [];

  constructor(
    private readonly protocol: IMessagePassingProtocol,
    private readonly owner: IpcConnectionScopeOwner<TContext>,
  ) {}

  /** owner 先登记 scope 再启动；订阅内同步关闭时，迟到返回的句柄立即释放。 */
  initialize(onDidClientDisconnect: Event<void>): void {
    if (this.closed) return;
    try {
      this.ownResource(onDidClientDisconnect(() => this.close()));
      if (this.closed) return;
      this.ownResource(Event.once(this.protocol.onMessage)((msg) => this.accept(msg)));
    } catch (error) {
      disposeIpcResource(this);
      throw error;
    }
  }

  private ownResource(resource: IDisposable): void {
    if (this.closed) disposeIpcResource(resource);
    else this.resources.push(resource);
  }

  /** 已接纳的连接；仍在等待握手的 scope 返回 undefined。 */
  get connection(): IpcConnection<TContext> | undefined {
    return this.accepted;
  }

  private accept(msg: VSBuffer): void {
    if (this.closed) return; // 关闭后到达的迟到身份帧：scope 已终结，直接忽略
    try {
      const reader = new BufferReader(msg);
      const ctx = deserialize(reader) as TContext;
      // 成对构造会在服务端 Initialize 同步关闭后仍创建客户端、额外订阅。
      // 逐个取得并交给同一 owner，关闭后不再继续构造；迟到资源也立即释放。
      const channelServer = this.owner.createChannelServer(this.protocol, ctx);
      this.ownResource(channelServer);
      if (this.closed) return;
      const channelClient = this.owner.createChannelClient(this.protocol);
      this.ownResource(channelClient);
      if (this.closed) return;
      this.owner.forEachRegisteredChannel((name, channel) =>
        channelServer.registerChannel(name, channel),
      );
      if (this.closed) return;
      const connection: IpcConnection<TContext> = { ctx, channelServer, channelClient };
      this.accepted = connection;
      // add 通知可能重入关闭；close 先摘除连接视图，再释放统一资源并通知 remove。
      this.owner.acceptConnection(connection);
    } catch (error) {
      // 取得后续资源或登记失败时也走同一终态，不能遗留已取得的半初始化通道。
      disposeIpcResource(this);
      throw error;
    }
  }

  /** 幂等关闭：先进入不可逆 closed 并摘除登记，再解绑监听、释放资源、通知一次 remove。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.owner.removeScope(this);
    const accepted = this.accepted;
    this.accepted = undefined;
    for (const resource of this.resources.splice(0)) disposeIpcResource(resource);
    if (!accepted) return; // 等待握手中的 scope 关闭不产生 remove
    // 资源列表已排空；仅通知一次 remove，不再按 accepted 重复释放通道。
    this.owner.notifyRemoved(accepted);
  }

  dispose(): void {
    this.close();
  }
}

/** IpcRoutingWait 观察 IPCServer 的最小接口。 */
export interface IpcRoutingWaitHub<TContext> {
  /** 当前活跃连接派生视图；每次求值，路由结果只能是其中一员。 */
  activeConnections(): IpcConnection<TContext>[];
  /** 新增连接事件；等待项的监听由统一 finish 解除。 */
  readonly onDidAddConnection: Event<IpcConnection<TContext>>;
  /** 从 IPCServer 的等待项登记中移除本等待。 */
  removeRoutingWait(wait: IpcRoutingWait<TContext>): void;
}

const cancelledError = (): Error => new Error("Cancelled");
const serverDisposedError = (): Error => new Error("IPCServer is disposed");
const staleRouteError = (): Error => new Error("Routed connection is no longer active");

/**
 * 一条未路由调用的路由等待：IPCServer 是唯一 owner，所有终结统一 finish。
 *
 * 路由阶段持有独立的阶段取消源（stageSource）：
 * - 用户取消联动 cancel；server dispose 主动 cancel；正常选中只 dispose、不 cancel；
 * - ChannelClient 始终收到原用户 token，移交后的取消仍然有效；
 * - 自定义 router 忽略阶段 token 时，RPC 仍及时拒绝并丢弃迟到结果；
 *   router 自建的外部资源仍由 router 自担。
 */
export class IpcRoutingWait<TContext> implements IDisposable {
  private finished = false;
  private disposedByServer = false;
  private readonly stageSource = new CancellationTokenSource();
  private readonly subscriptions: IDisposable[] = [];

  constructor(
    private readonly hub: IpcRoutingWaitHub<TContext>,
    private readonly resolve: (connection: IpcConnection<TContext>) => void,
    private readonly reject: (error: unknown) => void,
  ) {}

  /** filter 路径：先选当前活跃连接，未命中则登记新增连接等待；监听由统一 finish 解除。 */
  startFilter(
    filter: (client: { readonly ctx: TContext }) => boolean,
    userToken?: CancellationToken,
  ): void {
    if (!this.begin(userToken)) return;
    try {
      // 谓词可同步取消；每次调用外部代码前查终态，不能让 find 继续访问后续候选。
      const initial = this.hub
        .activeConnections()
        .find((candidate) => !this.finished && filter(candidate));
      if (this.finished) return; // 谓词自身可能同步取消，不能在终态后再安装等待。
      if (initial) {
        this.finishAndHandOff(initial);
        return;
      }
      this.ownSubscription(
        this.hub.onDidAddConnection((candidate) => {
          if (this.finished) return;
          try {
            if (filter(candidate)) this.finishAndHandOff(candidate);
          } catch (error) {
            this.finishAndReject(error); // 谓词失败只终结本等待，不向连接接纳事件链抛错。
          }
        }),
      );
    } catch (error) {
      this.finishAndReject(error);
    }
  }

  /** router 路径：把阶段 token 交给 router（既有可选 cancellationToken 参数）。 */
  startRouter(
    route: (stageToken: CancellationToken) => Promise<{ readonly ctx: TContext }>,
    userToken?: CancellationToken,
  ): void {
    if (!this.begin(userToken)) return;
    try {
      void Promise.resolve(route(this.stageSource.token)).then(
        (client) => {
          if (this.finished) return; // 整体丢弃迟到结果，不读取其 getter 或求活跃列表。
          try {
            // 资源对象保留原引用选择且拒绝失效实例；纯 Client 标识按公开 ctx 契约选择。
            // 属性存在性与 ctx getter 都可能同步重入终结；每次访问后先查终态。
            const hasClient = "channelClient" in client;
            if (this.finished) return;
            const explicit = hasClient || "channelServer" in client;
            if (this.finished) return;
            // 标识只取一次；不能在 find 的每个候选上重复读取外部 getter。
            const ctx = explicit ? undefined : client.ctx;
            if (this.finished) return;
            const connection = this.hub
              .activeConnections()
              .find(
                (candidate) =>
                  !this.finished && (explicit ? candidate === client : candidate.ctx === ctx),
              );
            if (connection) this.finishAndHandOff(connection);
            else this.finishAndReject(staleRouteError());
          } catch (error) {
            this.finishAndReject(error);
          }
        },
        (error) => this.finishAndReject(error),
      );
    } catch (error) {
      this.finishAndReject(error);
    }
  }

  /** 主动取消阶段源；外部 router 的取消回调抛错也不能打断 server 的终结遍历。 */
  dispose(): void {
    if (this.finished) return;
    this.disposedByServer = true;
    this.cancel();
  }

  private ownSubscription(subscription: IDisposable): void {
    if (this.finished) disposeIpcResource(subscription);
    else this.subscriptions.push(subscription);
  }

  private cancel(): void {
    if (this.finished) return;
    try {
      this.stageSource.cancel();
    } catch {
      // 取消回调由外部 router 拥有，异常不能阻断本方 settle 或其余 scope 关闭。
    } finally {
      this.finishAndReject(this.disposedByServer ? serverDisposedError() : cancelledError());
    }
  }

  /** 安装监听都走唯一拥有路径，覆盖订阅期间同步取消和迟到句柄。 */
  private begin(userToken: CancellationToken | undefined): boolean {
    try {
      this.ownSubscription(
        this.stageSource.token.onCancellationRequested(() => {
          this.finishAndReject(this.disposedByServer ? serverDisposedError() : cancelledError());
        }),
      );
      if (userToken?.isCancellationRequested) this.cancel();
      else if (userToken)
        this.ownSubscription(userToken.onCancellationRequested(() => this.cancel()));
    } catch (error) {
      this.finishAndReject(error);
    }
    return !this.finished;
  }

  /** 统一终结：先移除 owner 登记并解除全部监听，再释放阶段源并 settle。 */
  private finish(): boolean {
    if (this.finished) return false;
    this.finished = true;
    this.hub.removeRoutingWait(this);
    for (const subscription of this.subscriptions.splice(0)) {
      disposeIpcResource(subscription);
    }
    disposeIpcResource(this.stageSource);
    return true;
  }

  private finishAndHandOff(connection: IpcConnection<TContext>): void {
    if (this.finished) return;
    if (!this.hub.activeConnections().includes(connection)) {
      this.finishAndReject(staleRouteError());
      return;
    }
    if (!this.finish()) return;
    this.resolve(connection);
  }

  private finishAndReject(error: unknown): void {
    if (!this.finish()) return;
    this.reject(error);
  }
}

/**
 * 等待 hub 出现新增连接；token 取消时解除监听并拒绝。
 * 不使用 timeout，也不使用残留监听的 Promise.race。
 */
export function waitForHubConnection<TContext>(
  hub: { readonly onDidAddConnection: Event<IpcConnection<TContext>> },
  cancellationToken: CancellationToken | undefined,
): Promise<IpcConnection<TContext>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const subscriptions: IDisposable[] = [];
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      for (const subscription of subscriptions.splice(0)) disposeIpcResource(subscription);
      settle();
    };
    // 事件可以在订阅函数返回前同步触发：终态后的迟到句柄立即释放，不能引用未初始化变量。
    const ownSubscription = (subscription: IDisposable): void => {
      if (settled) disposeIpcResource(subscription);
      else subscriptions.push(subscription);
    };
    try {
      if (cancellationToken?.isCancellationRequested) {
        finish(() => reject(cancelledError()));
        return;
      }
      ownSubscription(hub.onDidAddConnection((connection) => finish(() => resolve(connection))));
      if (settled) return;
      if (cancellationToken?.isCancellationRequested) {
        finish(() => reject(cancelledError()));
        return;
      }
      if (cancellationToken)
        ownSubscription(
          cancellationToken.onCancellationRequested(() => finish(() => reject(cancelledError()))),
        );
    } catch (error) {
      finish(() => reject(error));
    }
  });
}
