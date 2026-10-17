import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { Emitter, VSBuffer, type Event } from "@zcode/rpc";
import { wrapStdioStream } from "../src/remote/stdio-socket.js";

function fixture() {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const stderr = new PassThrough();
  const close = new Emitter<number>();
  return { stdout, stdin, stderr, close, onClose: close.event };
}

describe("stdio socket listener ownership", () => {
  it("preserves active bytes, writes and EOF/close delivery", () => {
    const stream = fixture();
    const socket = wrapStdioStream(stream);
    const events: string[] = [];
    const writes: Buffer[] = [];
    socket.onData((chunk) => events.push(chunk.toString()));
    socket.onEnd(() => events.push("end"));
    socket.onClose(() => events.push("close"));
    stream.stdin.on("data", (chunk: Buffer) => writes.push(chunk));
    try {
      stream.stdout.emit("data", Buffer.from("bytes"));
      socket.write(VSBuffer.fromString("request"));
      stream.stdout.emit("end");
      stream.close.fire(0);
      expect(events).toEqual(["bytes", "end", "close", "end"]);
      expect(Buffer.concat(writes).toString()).toBe("request");
    } finally {
      socket.dispose();
      stream.stdout.destroy();
      stream.stderr.destroy();
      stream.stdin.destroy();
      stream.close.dispose();
    }
  });

  it("releases its listeners on every disposal and preserves other owners", () => {
    const stream = fixture();
    const closeEvents = new EventEmitter();
    const otherData = vi.fn();
    const otherEnd = vi.fn();
    const otherClose = vi.fn();
    stream.stdout.on("data", otherData);
    stream.stdout.on("end", otherEnd);
    closeEvents.on("close", otherClose);
    const onClose: Event<number> = (listener) => {
      closeEvents.on("close", listener);
      return {
        dispose: () => {
          closeEvents.off("close", listener);
        },
      };
    };
    try {
      for (let index = 0; index < 100; index += 1) {
        const socket = wrapStdioStream({ ...stream, onClose });
        expect(stream.stdout.listenerCount("data")).toBe(2);
        expect(stream.stdout.listenerCount("end")).toBe(2);
        expect(closeEvents.listenerCount("close")).toBe(2);
        socket.dispose();
        expect(stream.stdout.listenerCount("data")).toBe(1);
        expect(stream.stdout.listenerCount("end")).toBe(1);
        expect(closeEvents.listenerCount("close")).toBe(1);
      }
      stream.stdout.emit("data", Buffer.from("other"));
      stream.stdout.emit("end");
      closeEvents.emit("close", 0);
      expect(otherData).toHaveBeenCalledOnce();
      expect(otherEnd).toHaveBeenCalledOnce();
      expect(otherClose).toHaveBeenCalledOnce();
    } finally {
      stream.stdout.destroy();
      stream.stderr.destroy();
      stream.stdin.destroy();
      stream.close.dispose();
    }
  });

  it("does no byte conversion or delivery after disposal and ends stdin once", () => {
    const stream = fixture();
    const socket = wrapStdioStream(stream);
    const received = vi.fn();
    socket.onData(received);
    socket.onEnd(received);
    socket.onClose(received);
    const end = vi.spyOn(stream.stdin, "end");
    const wrap = vi.spyOn(VSBuffer, "wrap");
    try {
      socket.dispose();
      socket.dispose();
      wrap.mockClear();
      stream.stdout.emit("data", Buffer.alloc(1024 * 1024));
      stream.stdout.emit("end");
      stream.close.fire(0);
      expect(wrap).not.toHaveBeenCalled();
      expect(received).not.toHaveBeenCalled();
      expect(end).toHaveBeenCalledOnce();
    } finally {
      wrap.mockRestore();
      end.mockRestore();
      stream.stdout.destroy();
      stream.stderr.destroy();
      stream.stdin.destroy();
      stream.close.dispose();
    }
  });

  it("ignores a close callback already queued before disposal", async () => {
    const stream = fixture();
    const onClose: Event<number> = (listener) => {
      queueMicrotask(() => listener(0));
      return { dispose() {} };
    };
    const socket = wrapStdioStream({ ...stream, onClose });
    const received = vi.fn();
    socket.onClose(received);
    socket.onEnd(received);
    try {
      socket.dispose();
      await Promise.resolve();
      expect(received).not.toHaveBeenCalled();
    } finally {
      stream.stdout.destroy();
      stream.stderr.destroy();
      stream.stdin.destroy();
      stream.close.dispose();
    }
  });
});
