import { MessageChannel } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import {
  CancellationTokenSource,
  ChannelClient,
  ChannelServer,
  Emitter,
  MessagePortProtocol,
  SocketProtocol,
  type IMessagePassingProtocol,
  type IServerChannel,
  type ISocket,
  type MessagePortLike,
  type VSBuffer,
} from "../src/index.js";

type Transport = "direct" | "message-port" | "socket";

function pair(kind: Transport): {
  client: IMessagePassingProtocol;
  server: IMessagePassingProtocol;
  dispose(): void;
} {
  if (kind === "message-port") {
    const { port1, port2 } = new MessageChannel();
    const client = new MessagePortProtocol(port1 as unknown as MessagePortLike);
    const server = new MessagePortProtocol(port2 as unknown as MessagePortLike);
    return {
      client,
      server,
      dispose() {
        client.disconnect();
        server.disconnect();
      },
    };
  }
  const a = new Emitter<VSBuffer>();
  const b = new Emitter<VSBuffer>();
  if (kind === "direct")
    return {
      client: { onMessage: a.event, send: (data) => b.fire(data) },
      server: { onMessage: b.event, send: (data) => a.fire(data) },
      dispose() {
        a.dispose();
        b.dispose();
      },
    };
  const socket = (input: Emitter<VSBuffer>, output: Emitter<VSBuffer>): ISocket => ({
    onData: input.event,
    onClose: () => ({ dispose() {} }),
    onEnd: () => ({ dispose() {} }),
    write: (data) => output.fire(data),
    end() {},
    async drain() {},
    dispose() {},
  });
  const client = new SocketProtocol(socket(a, b));
  const server = new SocketProtocol(socket(b, a));
  return {
    client,
    server,
    dispose() {
      client.dispose();
      server.dispose();
      a.dispose();
      b.dispose();
    },
  };
}

describe("connection lifecycle across production transport shapes", () => {
  it.each<Transport>(["direct", "message-port", "socket"])(
    "%s keeps initialization, errors, cancel, resubscribe and close consistent",
    async (kind) => {
      const transport = pair(kind);
      const client = new ChannelClient(transport.client);
      const server = new ChannelServer(transport.server, "fixture", 1000, true);
      const source = new Emitter<number>();
      const cancellation = new CancellationTokenSource();
      let subscriptions = 0;
      let cancelled = 0;
      let resolvePending: ((value: unknown) => void) | undefined;
      let serializedLate = 0;
      const business: IServerChannel = {
        async call<T>(_ctx, command, arg, token) {
          if (command === "error")
            throw Object.assign(new Error("fixture"), { code: "code", details: { ok: true } });
          if (command === "object-error") throw { reason: "fixture" };
          if (command === "pending") {
            token!.onCancellationRequested(() => cancelled++);
            return new Promise<T>((resolve) => {
              resolvePending = resolve as (value: unknown) => void;
            });
          }
          return arg as T;
        },
        listen<T>() {
          return (listener: (data: T) => void) => {
            subscriptions++;
            const resource = source.event(listener as (data: number) => void);
            return {
              dispose() {
                subscriptions--;
                resource.dispose();
              },
            };
          };
        },
      };
      const remote = client.getChannel("fixture");
      server.registerChannel("fixture", business);
      try {
        const waiting = remote.call("echo", "before initialize");
        const event = remote.listen<number>("event");
        event(() => {
          throw new Error("abandoned event revived");
        }).dispose();
        server.ready();
        await expect(waiting).resolves.toBe("before initialize");
        await expect(remote.call("error")).rejects.toMatchObject({
          message: "fixture",
          code: "code",
          details: { ok: true },
        });
        await expect(remote.call("object-error")).rejects.toEqual({ reason: "fixture" });

        const received: number[] = [];
        let firstHandle: { dispose(): void } | undefined;
        const firstDelivery = new Promise<void>((resolve) => {
          firstHandle = event((value) => {
            received.push(value);
            resolve();
          });
        });
        await remote.call("barrier");
        source.fire(7);
        await firstDelivery;
        firstHandle!.dispose();
        await remote.call("barrier");
        expect(subscriptions).toBe(0);
        let secondHandle: { dispose(): void };
        const secondDelivery = new Promise<void>((resolve) => {
          secondHandle = event((value) => {
            received.push(value);
            resolve();
          });
        });
        await remote.call("barrier");
        expect(subscriptions).toBe(1);
        source.fire(8);
        await secondDelivery;
        expect(received).toEqual([7, 8]);

        const pending = remote.call("pending", undefined, cancellation.token);
        const rejected = expect(pending).rejects.toThrow("Cancelled");
        await remote.call("barrier");
        cancellation.cancel();
        await rejected;
        await remote.call("barrier");
        expect(cancelled).toBe(1);
        resolvePending!({
          toJSON() {
            serializedLate++;
            return "late";
          },
        });
        await remote.call("barrier");
        expect(serializedLate).toBe(0);

        const closing = remote.call("pending");
        const closed = expect(closing).rejects.toMatchObject({ name: "ConnectionClosed" });
        await remote.call("barrier");
        client.dispose();
        await closed;
        server.dispose();
        expect(subscriptions).toBe(0);
        secondHandle!.dispose();
        expect((client as unknown as { requests: Map<number, unknown> }).requests.size).toBe(0);
      } finally {
        client.dispose();
        server.dispose();
        cancellation.dispose();
        source.dispose();
        transport.dispose();
      }
    },
  );
});
