import { Emitter, VSBuffer, type ISocket } from "@zcode/rpc";
import type { StdioStream } from "./backend.js";

/**
 * Wrap a StdioStream (from IRemoteBackend.exec()) as an ISocket
 * for use with SocketProtocol → ChannelClient → RemoteServiceAccess.
 *
 * Follows the same pattern as wrapWebSocket in packages/server/src/http.ts
 * and wrapBrowserWebSocket in packages/client/src/websocket.ts.
 */
export function wrapStdioStream(stream: StdioStream): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();
  let disposed = false;

  const receive = (chunk: Buffer) => {
    if (disposed) return;
    onData.fire(VSBuffer.wrap(new Uint8Array(chunk)));
  };

  const end = () => {
    if (disposed) return;
    onEnd.fire();
  };

  stream.stdout.on("data", receive);
  stream.stdout.on("end", end);
  const closeSubscription = stream.onClose(() => {
    if (disposed) return;
    onClose.fire();
    onEnd.fire();
  });

  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer) {
      stream.stdin.write(Buffer.from(buffer.buffer));
    },
    end() {
      stream.stdin.end();
    },
    drain() {
      const stdin = stream.stdin as NodeJS.WritableStream & {
        writableNeedDrain?: boolean;
        once(event: "drain", listener: () => void): unknown;
      };
      return new Promise<void>((resolve) => {
        if (stdin.writableNeedDrain) {
          stdin.once("drain", resolve);
        } else {
          resolve();
        }
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      // backend 可能仍在异步退出；仅 end stdin 会保留回调并继续复制迟到 stdout。
      // 先释放本 owner 的监听与 emitter，再发送 EOF，防止同步重入或已排队 close 复活投递。
      stream.stdout.removeListener("data", receive);
      stream.stdout.removeListener("end", end);
      closeSubscription.dispose();
      onData.dispose();
      onClose.dispose();
      onEnd.dispose();
      stream.stdin.end();
    },
  };
}
