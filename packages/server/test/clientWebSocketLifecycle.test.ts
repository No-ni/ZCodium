import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { connectViaWebSocket } from "@zcode/client";
import { IBroadcastService, ISystemService } from "@zcode/services";
import {
  ChannelClient,
  ChannelServer,
  Emitter,
  SocketProtocol,
  VSBuffer,
  type ISocket,
} from "@zcode/rpc";

afterEach(() => vi.restoreAllMocks());

describe("browser WebSocket connection owns its RPC lifecycle", () => {
  it.each(["waiting", "active", "closing"])(
    "close settles pending calls (%s) before notifying the caller",
    async (phase) => {
      const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      await once(wss, "listening");
      const address = wss.address();
      if (typeof address === "string" || !address) throw new Error("missing test server port");
      const connected = once(wss, "connection");
      const disposedClient = vi.spyOn(ChannelClient.prototype, "dispose");
      const disposedProtocol = vi.spyOn(SocketProtocol.prototype, "dispose");
      let settledInClose: unknown;
      let browserSocket!: WebSocket;
      let closeObserved!: () => void;
      const closed = new Promise<void>((resolve) => {
        closeObserved = resolve;
      });
      const access = connectViaWebSocket(`ws://127.0.0.1:${address.port}`, {
        onOpenSocket(socket) {
          browserSocket = socket;
        },
        onClose() {
          settledInClose = disposedClient.mock.calls.length;
          closeObserved();
        },
      });
      const [ws] = await connected;
      const data = new Emitter<VSBuffer>();
      ws.on("message", (raw) => data.fire(VSBuffer.wrap(Buffer.from(raw as Buffer))));
      const socket: ISocket = {
        onData: data.event,
        onClose: () => ({ dispose() {} }),
        onEnd: () => ({ dispose() {} }),
        write: (buffer) => ws.send(buffer.buffer),
        end: () => ws.close(),
        async drain() {},
        dispose: () => ws.close(),
      };
      const protocol = new SocketProtocol(socket);
      const server = new ChannelServer(protocol, "websocket-fixture", 1000, true);
      let callObserved!: () => void;
      const called = new Promise<void>((resolve) => {
        callObserved = resolve;
      });
      server.registerChannel(ISystemService.channelName, {
        call: () => {
          callObserved();
          return new Promise(() => {});
        },
        listen: () => () => ({ dispose() {} }),
      });
      server.registerChannel(IBroadcastService.channelName, {
        async call<T>() {
          return undefined as T;
        },
        listen: () => () => ({ dispose() {} }),
      });
      const services = await access;
      const subscription = services.broadcastService.onMessage(() => {});
      const pending = services.systemService.info();
      const result = pending.then(
        () => "resolved",
        (error: unknown) => error,
      );
      try {
        if (phase !== "waiting") {
          server.ready();
          await called;
        }
        if (phase === "closing") {
          browserSocket.close(1000, "fixture close");
          await expect(services.systemService.info()).rejects.toThrow("WebSocket is not open");
        } else ws.close(1001, "fixture close");
        await closed;
        const outcome = await Promise.race([
          result,
          new Promise((resolve) => setTimeout(() => resolve("still pending"), 100)),
        ]);
        expect(outcome).toMatchObject({ name: "ConnectionClosed" });
        expect(settledInClose).toBe(1);
        expect(disposedProtocol).toHaveBeenCalledTimes(1);
        await expect(services.systemService.info()).rejects.toThrow("disposed");
        const client = disposedClient.mock.instances[0] as unknown as {
          requests: Map<number, unknown>;
        };
        expect(client.requests.size).toBe(0);
      } finally {
        subscription.dispose();
        disposedClient.mock.instances.forEach((client) => client.dispose());
        server.dispose();
        protocol.dispose();
        data.dispose();
        for (const peer of wss.clients) peer.terminate();
        await new Promise<void>((resolve) => wss.close(() => resolve()));
      }
    },
  );
});
