/**
 * Layer 4: 连接管理 —— IPCServer 和 IPCClient
 *
 * ChannelServer/ChannelClient 是单连接的 RPC 实现。
 * IPCServer/IPCClient 在其上构建连接管理能力：
 *
 * - IPCServer (1:N): 一个服务端接受多个客户端连接，每条连接由一个连接 scope
 *   从握手起独占拥有（见 ipcLifecycle.ts）。支持通过 Router 选择目标客户端进行调用；
 *   未路由调用的等待也由 IPCServer 统一登记，并在取消/dispose 时及时终结。
 *
 * - IPCClient (1:1 双向): 既是客户端又是服务端，
 *   可以调远端的 channel，也可以注册自己的 channel 供远端调用。
 *
 * 关键协议：客户端连接后发送的第一条消息是 ctx（上下文/客户端ID），
 * 服务端据此识别客户端身份。
 *
 * 所有权契约见 docs/specs/rpc-connection-ownership.md 与 rpc-client-lifecycle.md：
 * scope 先装 disconnect 再等 ctx、不 dispose 外部协议；connections 是已接纳 scope 的
 * 派生视图；未路由等待统一 finish（先移除登记并解除监听，再拒绝或移交调用）。
 */

import {
  Event,
  Emitter,
  IDisposable,
  DisposableStore,
  CancellationToken,
  EventMultiplexer,
} from "./foundation.js";
import { BufferWriter, serialize } from "./serialization.js";
import { IMessagePassingProtocol } from "./protocol.js";
import {
  IChannel,
  IServerChannel,
  IChannelServer,
  IChannelClient,
  ChannelServer,
  ChannelClient,
  getDelayedChannel,
} from "./channels.js";
import {
  disposeIpcResource,
  IpcConnectionScope,
  IpcRoutingWait,
  waitForHubConnection,
  type IpcConnection,
} from "./ipcLifecycle.js";

// ============================================================================
// Connection 相关接口
// ============================================================================

/** 客户端连接事件 */
export interface ClientConnectionEvent {
  protocol: IMessagePassingProtocol;
  readonly onDidClientDisconnect: Event<void>;
}

/** 客户端标识 */
export interface Client<TContext> {
  readonly ctx: TContext;
}

/** 连接 = 客户端标识 + 双向 channel；结构由 ipcLifecycle 的 IpcConnection 定义。 */
type Connection<TContext> = IpcConnection<TContext>;

/** 连接中心——暴露所有活跃连接 */
export interface IConnectionHub<TContext> {
  readonly connections: Connection<TContext>[];
  readonly onDidAddConnection: Event<Connection<TContext>>;
  readonly onDidRemoveConnection: Event<Connection<TContext>>;
}

/** 路由器——在多客户端场景中选择目标客户端 */
export interface IClientRouter<TContext = string> {
  routeCall(
    hub: IConnectionHub<TContext>,
    command: string,
    arg?: any,
    cancellationToken?: CancellationToken,
  ): Promise<Client<TContext>>;
  routeEvent(hub: IConnectionHub<TContext>, event: string, arg?: any): Promise<Client<TContext>>;
}

// ============================================================================
// IPCServer —— 一对多服务端
// ============================================================================

/**
 * IPCServer 是整个通信架构中的"大脑"。
 *
 * 它同时是：
 * - IChannelServer: 注册 channel 供客户端调用
 * - IRoutingChannelClient: 可以反向调用客户端的 channel（通过 Router 选择目标）
 * - IConnectionHub: 暴露所有活跃连接，支持连接增删事件
 *
 * 工作流程：监听 onDidClientConnect 为每条连接创建独占 scope；scope 先监听
 * disconnect 再等第一条消息（ctx = 客户端ID）；随后创建独立的 ChannelServer +
 * ChannelClient 并把已注册的 channel 推送给新连接。
 */
export class IPCServer<TContext = string>
  implements IChannelServer<TContext>, IConnectionHub<TContext>, IDisposable
{
  private channels = new Map<string, IServerChannel<TContext>>();
  // 连接所有权的唯一事实：scope 从等待 ctx 起持有每条连接；
  // 活跃 connections 是其中已接纳 scope 的派生视图，不另存一份活跃表。
  private readonly scopes = new Set<IpcConnectionScope<TContext>>();
  // 未路由调用等待项：IPCServer 是唯一 owner，dispose 时统一终结。
  private readonly routingWaits = new Set<IpcRoutingWait<TContext>>();
  private disposed = false;

  private readonly _onDidAddConnection = new Emitter<Connection<TContext>>();
  readonly onDidAddConnection = this._onDidAddConnection.event;

  private readonly _onDidRemoveConnection = new Emitter<Connection<TContext>>();
  readonly onDidRemoveConnection = this._onDidRemoveConnection.event;

  private readonly disposables = new DisposableStore();

  get connections(): Connection<TContext>[] {
    const connections: Connection<TContext>[] = [];
    for (const scope of this.scopes) {
      const connection = scope.connection;
      if (connection) connections.push(connection);
    }
    return connections;
  }

  constructor(onDidClientConnect: Event<ClientConnectionEvent>) {
    this.disposables.add(
      onDidClientConnect(({ protocol, onDidClientDisconnect }) => {
        if (this.disposed) return;
        // scope 从握手开始即拥有该连接：先装 disconnect 再等第一条 ctx 消息，
        // 握手前断开、初始化发送中关闭或 add 回调重入关闭都不再遗留 ghost，
        // 每连接监听由 scope 自持并在关闭时解除，不再永久堆入全局 DisposableStore。
        const scope = new IpcConnectionScope<TContext>(protocol, {
          createChannelServer: (channelProtocol, ctx) => new ChannelServer(channelProtocol, ctx),
          createChannelClient: (channelProtocol) => new ChannelClient(channelProtocol),
          forEachRegisteredChannel: (fn) =>
            this.channels.forEach((channel, name) => fn(name, channel)),
          acceptConnection: (connection) => this._onDidAddConnection.fire(connection),
          notifyRemoved: (connection) => this._onDidRemoveConnection.fire(connection),
          removeScope: (scope) => this.scopes.delete(scope),
        });
        // 先登记唯一 owner，再启动可能同步回调的订阅，关闭时才能正确摘除。
        this.scopes.add(scope);
        scope.initialize(onDidClientDisconnect);
      }),
    );
  }

  /**
   * 获取客户端的 channel（反向调用）。
   * 多个客户端时需要 router（IClientRouter 实现）或 filter（过滤函数）来选择目标。
   */
  getChannel<T extends IChannel>(
    channelName: string,
    routerOrFilter: IClientRouter<TContext> | ((client: Client<TContext>) => boolean),
  ): T {
    // 返回的 channel 方法有自己的 this；显式捕获当前 IPCServer。
    // oxlint-disable-next-line typescript/no-this-alias
    const that = this;
    const isFilter = typeof routerOrFilter === "function";

    return {
      call(command: string, arg?: any, cancellationToken?: CancellationToken): Promise<any> {
        if (isFilter) {
          // 未匹配 filter 的等待由 IPCServer 统一登记：用户取消与 server dispose
          // 都能及时终结，不再留下永久 pending 的 Promise 与悬挂监听。
          return that
            .routeUnroutedCall((wait) =>
              wait.startFilter(
                routerOrFilter as (c: Client<TContext>) => boolean,
                cancellationToken,
              ),
            )
            .then((connection) =>
              that.callAcceptedConnection(connection, channelName, command, arg, cancellationToken),
            );
        }
        // router 路径：routeCall 以既有可选 cancellationToken 参数接收阶段 token；
        // 移交后由原 ChannelClient.requests 接纳并始终使用原用户 token。
        return that
          .routeUnroutedCall((wait) =>
            wait.startRouter(
              (stageToken) =>
                (routerOrFilter as IClientRouter<TContext>).routeCall(
                  that,
                  command,
                  arg,
                  stageToken,
                ),
              cancellationToken,
            ),
          )
          .then((connection) =>
            that.callAcceptedConnection(connection, channelName, command, arg, cancellationToken),
          );
      },
      listen(event: string, arg?: any): Event<any> {
        if (isFilter) {
          return that.getMulticastEvent(
            channelName,
            routerOrFilter as (c: Client<TContext>) => boolean,
            event,
            arg,
          );
        }

        const channelPromise = (routerOrFilter as IClientRouter<TContext>)
          .routeEvent(that, event, arg)
          .then((c) => (c as Connection<TContext>).channelClient.getChannel(channelName));

        return getDelayedChannel(channelPromise).listen(event, arg);
      },
    } as T;
  }

  /**
   * 登记一个未路由调用等待项并启动。等待项先进入 owner 集合再启动监听，
   * dispose 遍历可以覆盖所有存活等待；已 dispose 的 server 直接拒绝新等待。
   */
  private routeUnroutedCall(
    start: (wait: IpcRoutingWait<TContext>) => void,
  ): Promise<Connection<TContext>> {
    if (this.disposed) return Promise.reject(new Error("IPCServer is disposed"));
    return new Promise<Connection<TContext>>((resolve, reject) => {
      const wait = new IpcRoutingWait<TContext>(
        {
          activeConnections: () => this.connections,
          onDidAddConnection: this.onDidAddConnection,
          removeRoutingWait: (pending) => this.routingWaits.delete(pending),
        },
        resolve,
        reject,
      );
      this.routingWaits.add(wait);
      start(wait);
    });
  }

  /**
   * 路由移交后的实际调用：只经原 ChannelClient.requests 接纳，不建立第二份请求表；
   * 正常移交只释放阶段源，不取消用户 token，移交后的取消仍然有效。
   */
  private callAcceptedConnection(
    connection: Connection<TContext>,
    channelName: string,
    command: string,
    arg: any,
    cancellationToken: CancellationToken | undefined,
  ): Promise<any> {
    const channelPromise = Promise.resolve(connection.channelClient.getChannel(channelName));
    return getDelayedChannel(channelPromise).call(command, arg, cancellationToken);
  }

  /** 聚合所有匹配客户端的同名事件为一个事件 */
  private getMulticastEvent<T>(
    channelName: string,
    filter: (c: Client<TContext>) => boolean,
    eventName: string,
    arg: any,
  ): Event<T> {
    // 返回的 channel 方法有自己的 this；显式捕获当前 IPCServer。
    // oxlint-disable-next-line typescript/no-this-alias
    const that = this;
    let disposables: DisposableStore | undefined;

    const emitter = new Emitter<T>({
      onWillAddFirstListener: () => {
        disposables = new DisposableStore();
        const multiplexer = new EventMultiplexer<T>();

        const onAdd = (connection: Connection<TContext>) => {
          const channel = connection.channelClient.getChannel(channelName);
          const event = channel.listen<T>(eventName, arg);
          multiplexer.add(event);
        };

        that.connections.filter(filter).forEach(onAdd);
        disposables.add(Event.filter(that.onDidAddConnection, filter)(onAdd));
        disposables.add(multiplexer.event((e) => emitter.fire(e)));
        disposables.add(multiplexer);
      },
      onDidRemoveLastListener: () => {
        disposables?.dispose();
        disposables = undefined;
      },
    });

    return emitter.event;
  }

  registerChannel(channelName: string, channel: IServerChannel<TContext>): void {
    this.channels.set(channelName, channel);

    // 推送到所有已连接的客户端（活跃连接由 scope 派生）
    for (const connection of this.connections) {
      connection.channelServer.registerChannel(channelName, channel);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    disposeIpcResource(this.disposables);
    // 先终结所有未路由等待（主动 cancel 阶段源并拒绝），再终结握手中与活动 scope；
    // 活动 scope 对已接纳连接各通知一次 remove，等待中的 scope 不产生 remove。
    // dispose 回调可重入终结集合内其它成员；快照遍历的是本次 dispose 开始时的成员。
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const wait of [...this.routingWaits]) disposeIpcResource(wait);
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const scope of [...this.scopes]) disposeIpcResource(scope);
    this.channels.clear();
    this._onDidAddConnection.dispose();
    this._onDidRemoveConnection.dispose();
  }
}

// ============================================================================
// IPCClient —— 一对一双向
// ============================================================================

/**
 * IPCClient 是双向的：
 * - 可以调远端的 channel (IChannelClient)
 * - 也可以注册自己的 channel 供远端调用 (IChannelServer)
 *
 * 第一条消息发送 ctx（自己的身份标识），这样服务端能识别你是谁。
 */
export class IPCClient<TContext = string>
  implements IChannelClient, IChannelServer<TContext>, IDisposable
{
  private channelClient: ChannelClient;
  private channelServer: ChannelServer<TContext>;

  constructor(protocol: IMessagePassingProtocol, ctx: TContext) {
    // 第一条消息：发送自己的身份标识
    const writer = new BufferWriter();
    serialize(writer, ctx);
    protocol.send(writer.buffer);

    this.channelClient = new ChannelClient(protocol);
    this.channelServer = new ChannelServer(protocol, ctx);
  }

  getChannel<T extends IChannel>(channelName: string): T {
    return this.channelClient.getChannel(channelName);
  }

  registerChannel(channelName: string, channel: IServerChannel<TContext>): void {
    this.channelServer.registerChannel(channelName, channel);
  }

  dispose(): void {
    this.channelClient.dispose();
    this.channelServer.dispose();
  }
}

// ============================================================================
// StaticRouter —— 简单路由器
// ============================================================================

/**
 * 根据静态条件选择客户端的路由器。
 * 例: new StaticRouter(ctx => ctx === 'main-window')
 */
export class StaticRouter<TContext = string> implements IClientRouter<TContext> {
  constructor(private fn: (ctx: TContext) => boolean | Promise<boolean>) {}

  async routeCall(
    hub: IConnectionHub<TContext>,
    _command?: string,
    _arg?: any,
    cancellationToken?: CancellationToken,
  ): Promise<Client<TContext>> {
    // 阶段 token 由 IPCServer 传入（既有可选 cancellationToken 参数）：
    // 取消时本路由器解除自己的新增连接等待并拒绝。
    return this.route(hub, cancellationToken);
  }

  async routeEvent(hub: IConnectionHub<TContext>): Promise<Client<TContext>> {
    return this.route(hub);
  }

  private async route(
    hub: IConnectionHub<TContext>,
    cancellationToken?: CancellationToken,
  ): Promise<Client<TContext>> {
    for (const connection of hub.connections) {
      if (cancellationToken?.isCancellationRequested) throw new Error("Cancelled");
      if (await Promise.resolve(this.fn(connection.ctx))) {
        return connection;
      }
    }
    // 等待新连接到来；取消时解除本等待监听并拒绝，不遗留订阅。
    await waitForHubConnection(hub, cancellationToken);
    return this.route(hub, cancellationToken);
  }
}
