import { randomUUID } from "node:crypto";
import { Emitter, VSBuffer, SocketProtocol, ChannelServer, type ISocket } from "@zcode/rpc";
import {
  IZCodeAgentService,
  createZCodeAgentConnectionScope,
  type ServiceCollection,
} from "@zcode/services";

/**
 * Wrap process.stdin/stdout as an ISocket for RPC communication.
 * In stdio mode, stdout is reserved exclusively for RPC data.
 * All logging must go through stderr.
 */
export function wrapStdio(): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();

  process.stdin.on("data", (chunk: Buffer) => {
    onData.fire(VSBuffer.wrap(new Uint8Array(chunk)));
  });
  process.stdin.on("end", () => {
    onClose.fire();
    onEnd.fire();
  });
  process.stdin.on("error", () => {
    onClose.fire();
    onEnd.fire();
  });

  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer) {
      process.stdout.write(Buffer.from(buffer.buffer));
    },
    end() {
      process.stdout.end();
    },
    drain() {
      return new Promise<void>((resolve) => {
        if (process.stdout.writableNeedDrain) {
          process.stdout.once("drain", resolve);
        } else {
          resolve();
        }
      });
    },
    dispose() {
      process.stdin.destroy();
    },
  };
}

export function createStdioTransport(socket: ISocket = wrapStdio()) {
  const protocol = new SocketProtocol(socket, { deferMessages: true });
  let channelServer: ChannelServer | undefined;
  let connectionScope: ReturnType<typeof createZCodeAgentConnectionScope> | undefined;
  let stopped = false;
  let ready = false;
  let stopPromise: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopped = true;
    // 先同步摘掉 protocol listener，保证从这一刻起不再接收新的 service RPC。
    channelServer?.dispose();
    protocol.dispose();
    stopPromise = (async () => {
      try {
        await connectionScope?.dispose();
      } finally {
        socket.dispose();
      }
    })();
    return stopPromise;
  };
  socket.onClose(() => {
    void stop();
  });
  return {
    attachServices(services: ServiceCollection): void {
      if (stopped) throw new Error("stdio transport is closed");
      if (channelServer) throw new Error("stdio services are already attached");
      // 初始化前只缓存原始帧，不创建业务请求或 unknown-channel timer。
      channelServer = new ChannelServer(protocol, "stdio", undefined, true);
      const agentService = services.getOptional(IZCodeAgentService);
      connectionScope = agentService
        ? createZCodeAgentConnectionScope(agentService, {
            connectionId: `server-stdio-${randomUUID()}`,
            clientMode: "desktop-continuous",
            role: "trusted-host-relay",
          })
        : undefined;
      services.exposeOnChannelServer(
        channelServer,
        connectionScope
          ? new Map([[IZCodeAgentService.channelName, connectionScope.service]])
          : new Map(),
      );
    },
    ready(): void {
      if (stopped || ready) return;
      if (!channelServer) throw new Error("stdio services are not attached");
      ready = true;
      channelServer.ready();
      protocol.activate();
    },
    stop,
  };
}

export function createStdioServer(services: ServiceCollection) {
  const transport = createStdioTransport();
  transport.attachServices(services);
  transport.ready();
  return { stop: transport.stop };
}
