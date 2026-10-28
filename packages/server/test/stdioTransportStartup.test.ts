import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BufferReader,
  BufferWriter,
  deserialize,
  Emitter,
  serialize,
  SocketProtocol,
  VSBuffer,
  type ISocket,
} from "@zcode/rpc";
import { createServiceDescriptor, ServiceCollection } from "@zcode/services";
import { waitForStdioAck } from "../src/stdio-ack.js";
import { startStdioProcess } from "../src/stdio-lifecycle.js";
import { createStdioTransport } from "../src/stdio.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function inputFixture() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as unknown as typeof process.stdin);
  vi.spyOn(process, "stdout", "get").mockReturnValue(stdout as unknown as typeof process.stdout);
  cleanups.push(() => {
    stdin.destroy();
    stdout.destroy();
  });
  const incoming = new Emitter<VSBuffer>();
  const closed = new Emitter<void>();
  const socket: ISocket = {
    onData: incoming.event,
    onClose: closed.event,
    onEnd: closed.event,
    write: (buffer) => stdin.write(Buffer.from(buffer.buffer)),
    end() {},
    async drain() {},
    dispose() {
      incoming.dispose();
      closed.dispose();
    },
  };
  const client = new SocketProtocol(socket);
  const responses: Array<{ header: number[]; value: unknown }> = [];
  client.onMessage((message) => {
    const reader = new BufferReader(message);
    responses.push({ header: deserialize(reader), value: deserialize(reader) });
  });
  const onOutput = (chunk: Buffer) => incoming.fire(VSBuffer.wrap(chunk));
  stdout.on("data", onOutput);
  cleanups.push(() => {
    stdout.off("data", onOutput);
    client.dispose();
    socket.dispose();
  });
  const request = (id: number, value = "fixture") => {
    const message = new BufferWriter();
    serialize(message, [100, id, "startup-fixture", "read"]);
    serialize(message, [value]);
    client.send(message.buffer);
  };
  return { stdin, stdout, responses, request };
}

async function turn() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("stdio transport startup ownership", () => {
  it("retains early requests without Initialize or channel timers until services are ready", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = inputFixture();
    f.stdin.pause();
    const transport = createStdioTransport();
    cleanups.push(() => {
      void transport.stop();
    });
    f.stdin.resume();
    f.request(1, "first");
    await turn();
    expect(f.responses).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(2_000);
    expect(f.responses).toEqual([]);
    const read = vi.fn(async (value: string) => value);
    const descriptor = createServiceDescriptor<{ read: typeof read }>("startup-fixture");
    transport.attachServices(new ServiceCollection().register(descriptor, { read }));
    expect(read).not.toHaveBeenCalled();
    expect(f.responses).toEqual([]);
    transport.ready();
    transport.ready();
    await turn();
    expect(f.responses).toEqual([
      { header: [200], value: undefined },
      { header: [201, 1], value: "first" },
    ]);
    f.request(2, "second");
    await turn();
    expect(read.mock.calls.map(([value]) => value)).toEqual(["first", "second"]);
    await transport.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["end", "close", "error"] as const)(
    "closes the paused ACK and early RPC stream during preparation on %s",
    async (event) => {
      const f = inputFixture();
      const acknowledged = waitForStdioAck(f.stdin);
      f.stdin.write(
        `${JSON.stringify({ type: "zcode-hello-ack", version: "fixture", clientId: "fixture" })}\n`,
      );
      await acknowledged;
      expect(f.stdin.isPaused()).toBe(true);
      f.request(1, "early");
      const prepared = Promise.withResolvers<string>();
      const exited = Promise.withResolvers<void>();
      const exit = vi.fn(() => exited.resolve());
      const createRuntime = vi.fn(() => {
        throw new Error("must not create a late runtime");
      });
      const ready = vi.fn();
      const starting = startStdioProcess({
        stdin: f.stdin,
        signalSource: new EventEmitter(),
        log: vi.fn(),
        createTransport: createStdioTransport,
        prepare: () => prepared.promise,
        createRuntime,
        ready,
        exit,
      });
      try {
        if (event === "end") f.stdin.end();
        else f.stdin.destroy(event === "error" ? new Error("fixture input error") : undefined);
        await exited.promise;
        expect(exit).toHaveBeenCalledExactlyOnceWith(event === "error" ? 1 : 0);
        prepared.resolve("late config");
        await starting;
        expect(createRuntime).not.toHaveBeenCalled();
        expect(ready).not.toHaveBeenCalled();
        expect(f.responses).toEqual([]);
      } finally {
        f.stdin.destroy();
        prepared.resolve("late config");
        await starting;
      }
    },
  );
});
