import { VSBuffer } from "./buffer.js";
import { CancellationToken, Event, Emitter, type IDisposable } from "./foundation.js";
import { BufferReader, BufferWriter, deserialize, serialize } from "./serialization.js";
import type { IMessagePassingProtocol } from "./protocol.js";
import {
  type IChannel,
  type IChannelClient,
  type IHandler,
  type IRawResponse,
  RequestType,
  ResponseType,
} from "./channels.shared.js";

interface RequestFailure {
  error: unknown;
}

interface ClientRequest {
  id: number;
  type: RequestType.Promise | RequestType.EventListen;
  phase: "waiting" | "sent";
  payload?: { channelName: string; name: string; arg: unknown };
  cancellation?: IDisposable;
  onResponse: IHandler;
  onClose: (failure?: RequestFailure) => void;
}

function release(resource?: IDisposable): void {
  try {
    resource?.dispose();
  } catch {
    // 请求终结后外部资源释放失败不能阻止 Promise settle 或其他请求回收。
  }
}

export class ChannelClient implements IChannelClient, IDisposable {
  private initialized = false;
  private isDisposed = false;
  // 表成员身份是请求是否存活的唯一事实，等待、接收和连接清理不再分别登记。
  private readonly requests = new Map<number, ClientRequest>();
  private lastRequestId = 0;
  private protocolListener: IDisposable | null;

  private readonly _onDidInitialize = new Emitter<void>();
  readonly onDidInitialize = this._onDidInitialize.event;

  constructor(private protocol: IMessagePassingProtocol) {
    this.protocolListener = this.protocol.onMessage((msg) => this.onBuffer(msg));
  }

  getChannel<T extends IChannel>(channelName: string): T {
    return {
      call: (command: string, arg?: any, cancellationToken?: CancellationToken) => {
        if (this.isDisposed) return Promise.reject(new Error("ChannelClient is disposed"));
        return this.requestPromise(channelName, command, arg, cancellationToken);
      },
      listen: (event: string, arg?: any) =>
        this.isDisposed ? Event.None : this.requestEvent(channelName, event, arg),
    } as T;
  }

  private requestPromise(
    channelName: string,
    name: string,
    arg?: any,
    cancellationToken = CancellationToken.None,
  ): Promise<any> {
    if (cancellationToken.isCancellationRequested) return Promise.reject(new Error("Cancelled"));

    return new Promise((resolve, reject) => {
      const request: ClientRequest = {
        id: this.lastRequestId++,
        type: RequestType.Promise,
        phase: "waiting",
        payload: { channelName, name, arg },
        onClose: (failure) => {
          if (failure) reject(failure.error);
        },
        onResponse: (response) => {
          switch (response.type) {
            case ResponseType.PromiseSuccess:
              this.finish(request);
              resolve(response.data);
              break;
            case ResponseType.PromiseError:
              this.finish(request, { error: responseError(response.data) });
              break;
            case ResponseType.PromiseErrorObj:
              this.finish(request, { error: response.data });
              break;
          }
        },
      };
      this.requests.set(request.id, request);
      try {
        const cancellation = cancellationToken.onCancellationRequested(() =>
          this.finish(request, { error: new Error("Cancelled") }, true),
        );
        // 注册取消回调可能同步终结请求；迟到返回的句柄也必须立即回收。
        if (this.requests.get(request.id) === request) request.cancellation = cancellation;
        else release(cancellation);
        if (this.initialized) this.dispatch(request);
      } catch (error) {
        this.finish(request, { error });
      }
    });
  }

  private requestEvent(channelName: string, name: string, arg?: any): Event<any> {
    let subscription: ClientRequest | undefined;
    const emitter = new Emitter<any>({
      onWillAddFirstListener: () => {
        if (this.isDisposed) {
          emitter.dispose();
          return;
        }
        const request: ClientRequest = {
          id: this.lastRequestId++,
          type: RequestType.EventListen,
          phase: "waiting",
          payload: { channelName, name, arg },
          onResponse: (response) => {
            if (response.type === ResponseType.EventFire) emitter.fire(response.data);
          },
          onClose: (failure) => {
            if (subscription === request) subscription = undefined;
            if (this.isDisposed || failure) emitter.dispose();
          },
        };
        subscription = request;
        this.requests.set(request.id, request);
        if (this.initialized) this.dispatch(request);
      },
      onDidRemoveLastListener: () => {
        if (subscription) this.finish(subscription, undefined, true);
      },
    });
    return emitter.event;
  }

  private dispatch(request: ClientRequest): void {
    if (this.requests.get(request.id) !== request || request.phase !== "waiting") return;
    const payload = request.payload!;
    request.payload = undefined;
    try {
      const writer = new BufferWriter();
      serialize(writer, [request.type, request.id, payload.channelName, payload.name]);
      serialize(writer, payload.arg);
      // toJSON 也可执行调用方代码；外部边界返回后只能推进仍存活的同一请求。
      if (this.requests.get(request.id) !== request) return;
      // 编码成功才可发送；先登记 sent，传输同步回复或重入取消也走同一终结入口。
      request.phase = "sent";
      this.protocol.send(writer.buffer);
    } catch (error) {
      this.finish(request, { error }, true);
    }
  }

  private finish(request: ClientRequest, failure?: RequestFailure, notifyPeer = false): void {
    if (this.requests.get(request.id) !== request) return;
    // 必须先删除：取消包可能同步触发迟到回复，不能让该回复抢先完成已取消请求。
    this.requests.delete(request.id);
    request.payload = undefined;
    release(request.cancellation);
    request.cancellation = undefined;
    request.onClose(failure);
    if (!notifyPeer || request.phase !== "sent") return;
    try {
      const writer = new BufferWriter();
      serialize(writer, [
        request.type === RequestType.Promise ? RequestType.PromiseCancel : RequestType.EventDispose,
        request.id,
      ]);
      serialize(writer, undefined);
      this.protocol.send(writer.buffer);
    } catch {
      // 本地终结已完成；终结包发送失败不恢复请求，也不阻塞其余请求清理。
    }
  }

  private onBuffer(message: VSBuffer): void {
    if (this.isDisposed) return;
    const reader = new BufferReader(message);
    const header = deserialize(reader);
    const body = deserialize(reader);
    const type = header[0] as ResponseType;
    if (type === ResponseType.Initialize) {
      this.initialized = true;
      // 初始化只调度唯一表中的等待请求；微任务执行时再核对身份，取消无需第二份等待监听。
      for (const request of this.requests.values()) {
        if (request.phase === "waiting") queueMicrotask(() => this.dispatch(request));
      }
      this._onDidInitialize.fire();
      return;
    }
    const request = this.requests.get(header[1]);
    if (request?.phase === "sent")
      request.onResponse({ type, id: header[1], data: body } as IRawResponse);
  }

  dispose(reason?: Error): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    release(this.protocolListener ?? undefined);
    this.protocolListener = null;
    const error = reason ?? new Error("ChannelClient disposed");
    if (!reason) error.name = "ConnectionClosed";
    for (const request of this.requests.values()) this.finish(request, { error }, true);
    this._onDidInitialize.dispose();
  }
}

function responseError(
  data: Extract<IRawResponse, { type: ResponseType.PromiseError }>["data"],
): Error {
  const error = new Error(data.message) as Error & Record<string, unknown>;
  error.name = data.name;
  if (data.stack) error.stack = data.stack.join("\n");
  const keys = [
    "code",
    "kind",
    "status",
    "retryAfterMs",
    "data",
    "detail",
    "details",
    "taskId",
    "traceId",
  ] as const;
  for (const key of keys) {
    if (data[key] !== undefined) error[key] = data[key];
  }
  return error;
}
