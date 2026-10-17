import {
  Emitter,
  VSBuffer,
  SocketProtocol,
  ChannelClient,
  type IMessagePassingProtocol,
  type ISocket,
} from "@zcode/rpc";
import type { IServiceAccessor } from "@zcode/services";
import { RemoteServiceAccess } from "./remoteServiceAccess.js";

export interface WebSocketConnectionCloseEvent {
  code: number;
  reason: string;
  wasClean: boolean;
}

interface WebSocketConnectionOptions {
  onClose?: (event: WebSocketConnectionCloseEvent) => void;
  onOpenSocket?: (socket: WebSocket) => void;
}

function wrapBrowserWebSocket(ws: WebSocket): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();

  ws.binaryType = "arraybuffer";
  const receive = (e: MessageEvent) => {
    onData.fire(VSBuffer.wrap(new Uint8Array(e.data as ArrayBuffer)));
  };
  const close = () => {
    onClose.fire();
    onEnd.fire();
  };
  ws.addEventListener("message", receive);
  ws.addEventListener("close", close);
  ws.addEventListener("error", close);

  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer) {
      // 静默丢弃会让已登记的 RPC 永远等待；发送失败交给唯一请求终结入口处理。
      if (ws.readyState !== WebSocket.OPEN) throw new Error("WebSocket is not open");
      ws.send(buffer.buffer as Uint8Array<ArrayBuffer>);
    },
    end() {
      ws.close();
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {
      ws.removeEventListener("message", receive);
      ws.removeEventListener("close", close);
      ws.removeEventListener("error", close);
      onData.dispose();
      onClose.dispose();
      onEnd.dispose();
      ws.close();
    },
  };
}

export function connectViaWebSocket(
  wsUrl: string,
  options?: WebSocketConnectionOptions,
): Promise<IServiceAccessor> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let settled = false;
    let connection:
      | { client: ChannelClient; protocol: SocketProtocol; socket: ISocket }
      | undefined;
    const disposeConnection = () => {
      const current = connection;
      // 连接 owner 先摘除所有权，error/close 或外部回调重入不会重复保留、释放旧连接。
      connection = undefined;
      if (!current) return;
      current.client.dispose();
      current.protocol.dispose();
      current.socket.dispose();
    };

    const onError = () => {
      disposeConnection();
      if (!settled) {
        settled = true;
        reject(new Error(`WebSocket connection failed: ${wsUrl}`));
        ws.close();
      }
    };
    const onClose = (event: CloseEvent) => {
      // 必须先结束 RPC 和协议缓存，再让 UI 获知断线，不能只关闭 socket 留下隐藏 Client。
      disposeConnection();
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
      ws.removeEventListener("close", onClose);
      if (!settled) {
        settled = true;
        reject(
          new Error(
            event.reason
              ? `WebSocket closed before ready: ${event.reason}`
              : `WebSocket closed before ready (${event.code})`,
          ),
        );
      }
      options?.onClose?.({ code: event.code, reason: event.reason, wasClean: event.wasClean });
    };
    const onOpen = () => {
      if (settled) return;
      const socket = wrapBrowserWebSocket(ws);
      const protocol = new SocketProtocol(socket);
      const client = new ChannelClient(protocol);
      connection = { client, protocol, socket };
      try {
        options?.onOpenSocket?.(ws);
      } catch (error) {
        settled = true;
        disposeConnection();
        reject(error);
        return;
      }
      if (settled) return;
      settled = true;
      resolve(new RemoteServiceAccess(client));
    };
    ws.addEventListener("error", onError);
    ws.addEventListener("close", onClose);
    ws.addEventListener("open", onOpen);
  });
}

export function connectViaProtocol(protocol: IMessagePassingProtocol): IServiceAccessor {
  const client = new ChannelClient(protocol);
  return new RemoteServiceAccess(client);
}
