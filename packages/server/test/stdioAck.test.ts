import { once } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Emitter, SocketProtocol, VSBuffer, type ISocket } from "@zcode/rpc";
import { waitForStdioAck } from "../src/stdio-ack.js";

const ack = { type: "zcode-hello-ack", version: "fixture版本", clientId: "fixture-client" };
const ackBytes = Buffer.from(`${JSON.stringify(ack)}\n`);
afterEach(() => vi.useRealTimers());

function rpcFrame(payload: Buffer): Buffer {
  const incoming = new Emitter<VSBuffer>();
  const close = new Emitter<void>();
  const writes: Buffer[] = [];
  const socket: ISocket = {
    onData: incoming.event,
    onClose: close.event,
    onEnd: close.event,
    write: (chunk) => writes.push(Buffer.from(chunk.buffer)),
    end() {},
    async drain() {},
    dispose() {},
  };
  const protocol = new SocketProtocol(socket);
  try {
    protocol.send(VSBuffer.wrap(payload));
    return Buffer.concat(writes);
  } finally {
    protocol.dispose();
    incoming.dispose();
    close.dispose();
  }
}

describe("stdio ACK byte ownership", () => {
  it("hands off every byte in order only after the next reader resumes stdin", async () => {
    const stdin = new PassThrough();
    const payload = Buffer.from(Array.from({ length: 256 }, (_, value) => value));
    const frame = rpcFrame(payload);
    const later = rpcFrame(Buffer.from("later"));
    const result = waitForStdioAck(stdin);
    try {
      stdin.write(Buffer.concat([ackBytes, frame]));
      expect(await result).toEqual(ack);
      expect(stdin.isPaused()).toBe(true);
      stdin.write(later);
      const received: Buffer[] = [];
      stdin.on("data", (chunk: Buffer) => received.push(chunk));
      expect(received).toEqual([]);
      stdin.resume();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(Buffer.concat(received)).toEqual(Buffer.concat([frame, later]));
    } finally {
      stdin.destroy();
    }
  });

  it("accepts UTF-8 string chunks from a readable with text encoding", async () => {
    const stdin = new PassThrough();
    stdin.setEncoding("utf-8");
    const result = waitForStdioAck(stdin);
    try {
      for (const byte of ackBytes) stdin.write(Buffer.from([byte]));
      expect(await result).toEqual(ack);
      expect(stdin.isPaused()).toBe(true);
    } finally {
      stdin.destroy();
    }
  });

  it.each(["json", "schema", "end", "close", "error", "timeout"] as const)(
    "releases only its own listeners and timer after %s rejection",
    async (kind) => {
      vi.useFakeTimers();
      const stdin = new PassThrough();
      const other = vi.fn();
      for (const event of ["data", "end", "close", "error"]) stdin.on(event, other);
      const result = waitForStdioAck(stdin).catch((error: unknown) => error);
      try {
        if (kind === "json") stdin.write("invalid JSON\n");
        else if (kind === "schema") stdin.write('{"type":"zcode-hello-ack"}\n');
        else if (kind === "timeout") vi.advanceTimersByTime(10_000);
        else stdin.emit(kind, new Error("fixture ACK failure"));
        expect(await result).toBeInstanceOf(Error);
        for (const event of ["data", "end", "close", "error"])
          expect(stdin.listeners(event)).toEqual([other]);
        expect(vi.getTimerCount()).toBe(0);
        stdin.emit("data", ackBytes);
        stdin.emit("end");
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        stdin.destroy();
      }
    },
  );

  it.each(["close", "error"] as const)(
    "rejects synchronous %s during subscription and removes late registration",
    async (event) => {
      vi.useFakeTimers();
      const stdin = new PassThrough();
      stdin.on("error", () => {});
      const originalOn = stdin.on;
      vi.spyOn(stdin, "on").mockImplementation(function (name, listener) {
        if (name === event) listener(new Error("fixture synchronous failure"));
        return originalOn.call(this, name, listener);
      });
      try {
        await expect(waitForStdioAck(stdin)).rejects.toThrow();
        expect(stdin.listenerCount("data")).toBe(0);
        expect(stdin.listenerCount("end")).toBe(0);
        expect(stdin.listenerCount("close")).toBe(0);
        expect(stdin.listenerCount("error")).toBe(1);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        stdin.destroy();
      }
    },
  );

  it.each(["ended", "destroyed", "errored"] as const)(
    "rejects an already %s stdin without leaving a timer",
    async (kind) => {
      const stdin = new PassThrough();
      stdin.on("error", () => {});
      if (kind === "ended") {
        stdin.resume();
        const ended = once(stdin, "end");
        stdin.end();
        await ended;
      } else {
        const closed = once(stdin, "close").catch(() => undefined);
        stdin.destroy(kind === "errored" ? new Error("fixture ended ACK") : undefined);
        await closed;
      }
      vi.useFakeTimers();
      try {
        await expect(waitForStdioAck(stdin)).rejects.toThrow();
        expect(vi.getTimerCount()).toBe(0);
        expect(stdin.listenerCount("data")).toBe(0);
      } finally {
        stdin.destroy();
      }
    },
  );

  it("preserves a real 164-byte RPC frame with payload length 151", async () => {
    const stdin = new PassThrough();
    const frame = rpcFrame(Buffer.alloc(151, 0x61));
    expect(frame.length).toBe(164);
    expect(frame.readUInt32BE(9)).toBe(151);
    const result = waitForStdioAck(stdin);
    try {
      stdin.write(Buffer.concat([ackBytes, frame]));
      expect(await result).toEqual(ack);
      const remaining = stdin.read() as Buffer;
      expect(remaining).toBeInstanceOf(Buffer);
      expect(remaining.length).toBe(164);
      expect(remaining.readUInt32BE(9)).toBe(151);
      expect(remaining).toEqual(frame);
    } finally {
      stdin.destroy();
    }
  });

  it("decodes UTF-8 ACK only after the complete line is available", async () => {
    const stdin = new PassThrough();
    const result = waitForStdioAck(stdin);
    try {
      for (const byte of ackBytes) stdin.write(Buffer.from([byte]));
      expect(await result).toEqual(ack);
      expect(stdin.isPaused()).toBe(true);
    } finally {
      stdin.destroy();
    }
  });
});
