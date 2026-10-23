import { getEventListeners, once } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Emitter } from "@zcode/rpc";
import type { StdioStream } from "../src/remote/backend.js";
import { performHandshake } from "../src/remote/handshake.js";

const hello = {
  type: "zcode-hello",
  version: "fixture版本",
  platform: "darwin",
  arch: "arm64",
  pid: 1,
};
const helloBytes = Buffer.from(`${JSON.stringify(hello)}\n`);

function fixture() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const close = new Emitter<number>();
  const stream: StdioStream = { stdin, stdout, stderr, onClose: close.event };
  return {
    stream,
    stdin,
    stdout,
    stderr,
    close,
    dispose() {
      stdin.destroy();
      stdout.destroy();
      stderr.destroy();
      close.dispose();
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("remote handshake byte and listener ownership", () => {
  it("preserves every RPC byte coalesced with hello and only writes one ack", async () => {
    const f = fixture();
    const ack = vi.spyOn(f.stream.stdin, "write");
    const rpc = Buffer.from(Array.from({ length: 256 }, (_, value) => value));
    const result = performHandshake(f.stream, "fixture-client");
    try {
      f.stream.stdout.write(Buffer.concat([helloBytes, rpc]));
      await vi.runAllTicks();
      expect(await result).toEqual({ hello, remaining: rpc });
      expect(f.stream.stdout.isPaused()).toBe(true);
      expect(ack).toHaveBeenCalledOnce();
      expect(JSON.parse(String(ack.mock.calls[0]![0]))).toMatchObject({
        type: "zcode-hello-ack",
        clientId: "fixture-client",
      });
      expect(f.stream.stdout.listenerCount("data")).toBe(0);
      expect(f.stream.stderr.listenerCount("data")).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      f.dispose();
    }
  });

  it("decodes complete UTF-8 lines after fragmented banners and hello", async () => {
    const f = fixture();
    const result = performHandshake(f.stream, "fixture-client");
    try {
      const bytes = Buffer.concat([Buffer.from("fixture banner\r\n"), helloBytes]);
      for (const byte of bytes) f.stdout.write(Buffer.from([byte]));
      await vi.runAllTicks();
      expect(await result).toEqual({ hello, remaining: null });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      f.dispose();
    }
  });

  it("rejects synchronous close during subscription and releases the returned handle", async () => {
    const f = fixture();
    const dispose = vi.fn();
    f.stream.onClose = (listener) => {
      listener(17);
      return { dispose };
    };
    try {
      await expect(performHandshake(f.stream, "fixture-client")).rejects.toThrow(
        "Stream closed before handshake completed (exit code 17)",
      );
      expect(dispose).toHaveBeenCalledOnce();
      expect(f.stream.stdout.listenerCount("data")).toBe(0);
      expect(f.stream.stderr.listenerCount("data")).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      f.dispose();
    }
  });

  it("rejects an ack write failure immediately instead of leaving a settled waiter pending", async () => {
    const f = fixture();
    const failure = new Error("fixture ack write failure");
    vi.spyOn(f.stream.stdin, "write").mockImplementation(() => {
      throw failure;
    });
    const result = performHandshake(f.stream, "fixture-client").catch((error: unknown) => error);
    try {
      f.stream.stdout.emit("data", helloBytes);
      await Promise.resolve();
      expect(await Promise.race([result, Promise.resolve("pending")])).toBe(failure);
      expect(f.stream.stdout.listenerCount("data")).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      f.dispose();
    }
  });

  it.each(["synchronous", "nextTick"])(
    "%s ACK reentry preserves later bytes in the paused Readable until the next owner resumes",
    async (timing) => {
      vi.useRealTimers();
      const f = fixture();
      const first = Buffer.from([0xff, 0x00, 0x80]);
      const later = Buffer.from([0xc3, 0x28, 0xfe]);
      const bytes: Buffer[] = [];
      let pausedInsideAck = false;
      const sent = new Promise<void>((resolve) => {
        f.stdin.once("data", () => {
          pausedInsideAck = f.stdout.isPaused();
          const send = () => {
            f.stdout.write(later);
            resolve();
          };
          if (timing === "synchronous") send();
          else process.nextTick(send);
        });
      });
      const handshake = performHandshake(f.stream, "fixture-client");
      try {
        f.stdout.write(Buffer.concat([helloBytes, first]));
        const result = await handshake;
        await sent;
        expect(pausedInsideAck).toBe(true);
        expect(f.stdout.isPaused()).toBe(true);
        expect(result.remaining).toEqual(first);
        f.stdout.unshift(result.remaining!);
        const receive = (chunk: Buffer) => bytes.push(chunk);
        f.stdout.on("data", receive);
        const ended = once(f.stdout, "end");
        f.stdout.resume();
        f.stdout.end();
        await ended;
        expect(Buffer.concat(bytes)).toEqual(Buffer.concat([first, later]));
        f.stdout.off("data", receive);
      } finally {
        f.dispose();
      }
    },
  );

  it.each(["sync-callback", "async-callback"])(
    "%s ACK failure from a real Writable rejects and releases error/close listeners",
    async (timing) => {
      vi.useRealTimers();
      const f = fixture();
      const failure = new Error("fixture ACK callback failure");
      let acknowledge!: (error?: Error | null) => void;
      const stdin = new Writable({
        highWaterMark: 1,
        write(_chunk, _encoding, callback) {
          if (timing === "sync-callback") callback(failure);
          else acknowledge = callback;
        },
      });
      const otherError = vi.fn();
      stdin.on("error", otherError);
      f.stream.stdin = stdin;
      const handshake = performHandshake(f.stream, "fixture-client").catch(
        (error: unknown) => error,
      );
      try {
        f.stdout.write(helloBytes);
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (timing === "async-callback") acknowledge(failure);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(await Promise.race([handshake, Promise.resolve("pending")])).toBe(failure);
        expect(otherError).toHaveBeenCalledOnce();
        expect(stdin.listeners("error")).toEqual([otherError]);
        expect(f.stdout.listenerCount("data")).toBe(0);
        expect(f.stdout.listenerCount("error")).toBe(0);
        expect(f.stderr.listenerCount("data")).toBe(0);
      } finally {
        stdin.destroy();
        f.dispose();
      }
    },
  );

  it("ACK backpressure waits for its callback rather than succeeding or rejecting on false", async () => {
    vi.useRealTimers();
    const f = fixture();
    let acknowledge!: (error?: Error | null) => void;
    const stdin = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        acknowledge = callback;
      },
    });
    f.stream.stdin = stdin;
    const handshake = performHandshake(f.stream, "fixture-client");
    try {
      f.stdout.write(helloBytes);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(stdin.writableNeedDrain).toBe(true);
      expect(await Promise.race([handshake, Promise.resolve("pending")])).toBe("pending");
      acknowledge();
      expect(await handshake).toEqual({ hello, remaining: null });
      expect(f.stdout.isPaused()).toBe(true);
    } finally {
      stdin.destroy();
      f.dispose();
    }
  });

  it.each(["before-hello", "inside-ACK"])(
    "%s abort releases the handshake timer and listeners without resuming stdout",
    async (stage) => {
      vi.useRealTimers();
      const f = fixture();
      const controller = new AbortController();
      const failure = new Error("fixture canceled handshake");
      if (stage === "inside-ACK") f.stdin.on("data", () => controller.abort(failure));
      const handshake = performHandshake(
        f.stream,
        "fixture-client",
        10_000,
        controller.signal,
      ).catch((error: unknown) => error);
      try {
        if (stage === "inside-ACK") f.stdout.write(helloBytes);
        else controller.abort(failure);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(await Promise.race([handshake, Promise.resolve("pending")])).toBe(failure);
        expect(f.stdout.listenerCount("data")).toBe(0);
        expect(f.stdout.listenerCount("end")).toBe(0);
        expect(f.stdout.listenerCount("close")).toBe(0);
        expect(f.stdout.listenerCount("error")).toBe(0);
        expect(f.stderr.listenerCount("data")).toBe(0);
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
        if (stage === "inside-ACK") expect(f.stdout.isPaused()).toBe(true);
      } finally {
        f.dispose();
      }
    },
  );

  it.each(["end", "close", "error"])(
    "stdout %s before hello terminates without a command-close event",
    async (kind) => {
      vi.useRealTimers();
      const f = fixture();
      const otherError = vi.fn();
      f.stdout.on("error", otherError);
      const handshake = performHandshake(f.stream, "fixture-client").catch(
        (error: unknown) => error,
      );
      try {
        if (kind === "end") f.stdout.end();
        else f.stdout.destroy(kind === "error" ? new Error("fixture stdout failure") : undefined);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(await Promise.race([handshake, Promise.resolve("pending")])).toBeInstanceOf(Error);
        expect(f.stdout.listenerCount("data")).toBe(0);
        expect(f.stdout.listeners("error")).toEqual([otherError]);
        expect(f.stderr.listenerCount("data")).toBe(0);
      } finally {
        f.dispose();
      }
    },
  );

  it.each(["success", "failure"])(
    "abort while ACK callback is pending releases every subscription before its late %s",
    async (lateResult) => {
      vi.useRealTimers();
      const f = fixture();
      const controller = new AbortController();
      const failure = new Error("fixture canceled pending ACK");
      let acknowledge!: (error?: Error | null) => void;
      const stdin = new Writable({
        write(_chunk, _encoding, callback) {
          acknowledge = callback;
        },
      });
      const otherError = vi.fn();
      stdin.on("error", otherError);
      f.stream.stdin = stdin;
      const handshake = performHandshake(
        f.stream,
        "fixture-client",
        10_000,
        controller.signal,
      ).catch((error: unknown) => error);
      try {
        f.stdout.write(helloBytes);
        await new Promise<void>((resolve) => setImmediate(resolve));
        controller.abort(failure);
        expect(await handshake).toBe(failure);
        expect(stdin.listeners("error")).toEqual([otherError]);
        expect(f.stdout.listenerCount("data")).toBe(0);
        expect(f.stdout.listenerCount("error")).toBe(0);
        acknowledge(lateResult === "failure" ? new Error("fixture late ACK failure") : undefined);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(stdin.listeners("error")).toEqual([otherError]);
        expect(otherError).toHaveBeenCalledTimes(lateResult === "failure" ? 1 : 0);
        expect(f.stdout.isPaused()).toBe(true);
      } finally {
        stdin.destroy();
        f.dispose();
      }
    },
  );

  it("already destroyed ACK stdin rejects without waiting for an error event that never arrives", async () => {
    vi.useRealTimers();
    const f = fixture();
    const stdin = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const otherError = vi.fn();
    stdin.on("error", otherError);
    stdin.destroy();
    await new Promise<void>((resolve) => setImmediate(resolve));
    f.stream.stdin = stdin;
    const handshake = performHandshake(f.stream, "fixture-client").catch((error: unknown) => error);
    try {
      f.stdout.write(helloBytes);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(await handshake).toMatchObject({ code: "ERR_STREAM_DESTROYED" });
      expect(stdin.listeners("error")).toEqual([otherError]);
      expect(otherError).not.toHaveBeenCalled();
      expect(f.stdout.listenerCount("data")).toBe(0);
    } finally {
      stdin.destroy();
      f.dispose();
    }
  });

  it.each(["closed", "errored"])(
    "abort then %s ACK stdin releases a late failure callback without reattaching an error listener",
    async (kind) => {
      vi.useRealTimers();
      const f = fixture();
      const controller = new AbortController();
      const failure = new Error("fixture canceled before stdin close");
      let acknowledge!: (error?: Error | null) => void;
      const stdin = new Writable({
        write(_chunk, _encoding, callback) {
          acknowledge = callback;
        },
      });
      const otherError = vi.fn();
      stdin.on("error", otherError);
      f.stream.stdin = stdin;
      const handshake = performHandshake(
        f.stream,
        "fixture-client",
        10_000,
        controller.signal,
      ).catch((error: unknown) => error);
      try {
        f.stdout.write(helloBytes);
        await new Promise<void>((resolve) => setImmediate(resolve));
        controller.abort(failure);
        expect(await handshake).toBe(failure);
        stdin.destroy(kind === "errored" ? new Error("fixture stdin canceled") : undefined);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(stdin.closed).toBe(true);
        acknowledge(new Error("fixture late ACK failure after close"));
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(stdin.listeners("error")).toEqual([otherError]);
        expect(otherError).toHaveBeenCalledTimes(kind === "errored" ? 1 : 0);
        expect(f.stdout.listenerCount("data")).toBe(0);
        expect(f.stdout.isPaused()).toBe(true);
      } finally {
        stdin.destroy();
        f.dispose();
      }
    },
  );

  it.each(["close", "invalid", "timeout"])(
    "%s rejection keeps other listeners and clears its own timer",
    async (kind) => {
      const f = fixture();
      const other = vi.fn();
      f.stream.stdout.on("data", other);
      const result = performHandshake(f.stream, "fixture-client", 100).catch(
        (error: unknown) => error,
      );
      try {
        if (kind === "close") f.close.fire(1);
        else if (kind === "invalid")
          f.stream.stdout.emit("data", Buffer.from('{"type":"zcode-hello"}\n'));
        else vi.advanceTimersByTime(100);
        expect(await result).toBeInstanceOf(Error);
        expect(f.stream.stdout.listeners("data")).toEqual([other]);
        expect(f.stream.stderr.listenerCount("data")).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        f.dispose();
      }
    },
  );
});
