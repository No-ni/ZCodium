import { VSBuffer } from "./buffer.js";
import { type IDisposable, CancellationTokenSource } from "./foundation.js";
import { BufferReader, BufferWriter, deserialize, serialize } from "./serialization.js";
import type { IMessagePassingProtocol } from "./protocol.js";
import {
  type IChannelServer,
  type IRawResponse,
  type IServerChannel,
  RequestType,
  ResponseType,
} from "./channels.shared.js";

interface ServerRequest {
  type: RequestType.Promise | RequestType.EventListen;
  id: number;
  channelName: string;
  name: string;
  arg: any;
}

interface RequestRecord {
  request: ServerRequest;
  phase: "waiting" | "active";
  timer?: ReturnType<typeof setTimeout>;
  cts?: CancellationTokenSource;
  subscription?: IDisposable;
}

function disposeResource(resource?: IDisposable): void {
  try {
    resource?.dispose();
  } catch {
    // 单个服务的释放回调失败不能中断同连接其他请求的清理。
  }
}

export class ChannelServer<TContext = string> implements IChannelServer<TContext>, IDisposable {
  private channels = new Map<string, IServerChannel<TContext>>();
  private requests = new Map<number, RequestRecord>();
  private channelFlushes = new Set<ReturnType<typeof setTimeout>>();
  private protocolListener: IDisposable | null;
  private isDisposed = false;

  constructor(
    private protocol: IMessagePassingProtocol,
    private ctx: TContext,
    private timeoutDelay = 1000,
    private deferInit = false,
  ) {
    this.protocolListener = this.protocol.onMessage((msg) => this.onRawMessage(msg));
    if (!this.deferInit) this.ready();
  }

  ready(): void {
    this.sendResponse({ type: ResponseType.Initialize });
  }

  registerChannel(channelName: string, channel: IServerChannel<TContext>): void {
    if (this.isDisposed) return;
    this.channels.set(channelName, channel);
    const timer = setTimeout(() => {
      this.channelFlushes.delete(timer);
      for (const record of this.requests.values()) {
        if (record.phase === "waiting" && record.request.channelName === channelName) {
          this.dispatch(record, this.channels.get(channelName)!);
        }
      }
    }, 0);
    this.channelFlushes.add(timer);
  }

  private serializationError(id: number): IRawResponse {
    return {
      type: ResponseType.PromiseError,
      id,
      data: {
        name: "SerializationError",
        message: "RPC response could not be serialized",
        stack: undefined,
      },
    };
  }

  private encodeResponse(response: IRawResponse): VSBuffer {
    const writer = new BufferWriter();
    serialize(writer, "id" in response ? [response.type, response.id] : [response.type]);
    serialize(writer, "data" in response ? response.data : undefined);
    return writer.buffer;
  }

  private sendResponse(response: IRawResponse, owner?: RequestRecord): boolean {
    if (this.isDisposed || (owner && !this.isCurrent(owner))) return false;
    let buffer: VSBuffer;
    try {
      buffer = this.encodeResponse(response);
    } catch {
      if (response.type === ResponseType.Initialize || response.type === ResponseType.EventFire)
        return false;
      // 结果或错误对象自身不可序列化时，仅发送一次不含用户数据的原协议错误。
      buffer = this.encodeResponse(this.serializationError(response.id));
    }
    // toJSON 等外部代码可能在编码中同步关闭连接。
    if (this.isDisposed || (owner && !this.isCurrent(owner))) return false;
    try {
      this.protocol.send(buffer);
      return true;
    } catch {
      return false;
    }
  }

  private onRawMessage(message: VSBuffer): void {
    if (this.isDisposed) return;
    const reader = new BufferReader(message);
    const header = deserialize(reader);
    const body = deserialize(reader);
    const type = header[0] as RequestType;
    if (type === RequestType.PromiseCancel || type === RequestType.EventDispose) {
      const record = this.requests.get(header[1]);
      if (record) this.finish(record, true);
      return;
    }
    if (type !== RequestType.Promise && type !== RequestType.EventListen) return;
    if (this.requests.has(header[1])) return;
    const request: ServerRequest = {
      type,
      id: header[1],
      channelName: header[2],
      name: header[3],
      arg: body,
    };
    const record: RequestRecord = { request, phase: "waiting" };
    this.requests.set(request.id, record);
    const channel = this.channels.get(request.channelName);
    if (channel) {
      this.dispatch(record, channel);
      return;
    }
    record.timer = setTimeout(() => {
      if (!this.finish(record)) return;
      console.error(`Unknown channel: ${request.channelName}`);
      if (request.type === RequestType.Promise) {
        this.sendResponse({
          id: request.id,
          data: {
            name: "Unknown channel",
            message: `Channel name '${request.channelName}' timed out after ${this.timeoutDelay}ms`,
            stack: undefined,
          },
          type: ResponseType.PromiseError,
        });
      }
    }, this.timeoutDelay);
  }

  private isCurrent(record: RequestRecord): boolean {
    return this.requests.get(record.request.id) === record;
  }

  private dispatch(record: RequestRecord, channel: IServerChannel<TContext>): void {
    if (!this.isCurrent(record)) return;
    if (record.timer) clearTimeout(record.timer);
    record.timer = undefined;
    record.phase = "active";
    const request = record.request;
    if (request.type === RequestType.EventListen) {
      try {
        record.subscription = channel.listen(
          this.ctx,
          request.name,
          request.arg,
        )((data) => {
          if (!this.isCurrent(record)) return;
          if (!this.sendResponse({ id: request.id, data, type: ResponseType.EventFire }, record))
            this.finish(record);
        });
        // 同步首事件可能已终结记录；迟到句柄仍交给同一 finish 回收。
        if (!this.isCurrent(record)) this.finish(record);
      } catch (error) {
        this.finish(record);
        throw error;
      }
      return;
    }
    const cts = new CancellationTokenSource();
    record.cts = cts;
    let promise: Promise<any>;
    try {
      promise = channel.call(this.ctx, request.name, request.arg, cts.token);
    } catch (error) {
      promise = Promise.reject(error);
    }
    void Promise.resolve(promise).then(
      (data) => {
        if (this.finish(record))
          this.sendResponse({ id: request.id, data, type: ResponseType.PromiseSuccess });
      },
      (error) => {
        if (!this.finish(record)) return;
        let response: IRawResponse;
        try {
          response = this.errorResponse(request.id, error);
        } catch {
          response = this.serializationError(request.id);
        }
        this.sendResponse(response);
      },
    );
  }

  private errorResponse(id: number, error: unknown): IRawResponse {
    if (!(error instanceof Error)) return { id, data: error, type: ResponseType.PromiseErrorObj };
    const data: Extract<IRawResponse, { type: ResponseType.PromiseError }>["data"] = {
      message: error.message,
      name: error.name,
      stack: error.stack ? error.stack.split("\n") : undefined,
    };
    const errorRecord = error as Error & Record<string, unknown>;
    const passthroughKeys = [
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
    for (const key of passthroughKeys) {
      const value = errorRecord[key];
      if (value !== undefined) data[key] = value;
    }
    return { id, data, type: ResponseType.PromiseError };
  }

  private finish(record: RequestRecord, cancel = false): boolean {
    const current = this.isCurrent(record);
    // 请求终态只在这里写入，必须先摘除所有权，外部取消/释放回调才能安全重入。
    if (current) this.requests.delete(record.request.id);
    if (record.timer) clearTimeout(record.timer);
    record.timer = undefined;
    const { cts, subscription } = record;
    record.cts = undefined;
    record.subscription = undefined;
    record.request.arg = undefined;
    try {
      if (cancel) cts?.cancel();
    } catch {
      // 取消通知的异常也必须经过下面的资源释放，不能留下其他活动请求。
    }
    disposeResource(cts);
    disposeResource(subscription);
    return current;
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    disposeResource(this.protocolListener ?? undefined);
    this.protocolListener = null;
    for (const timer of this.channelFlushes) clearTimeout(timer);
    this.channelFlushes.clear();
    for (const record of this.requests.values()) this.finish(record, true);
    this.channels.clear();
  }
}
