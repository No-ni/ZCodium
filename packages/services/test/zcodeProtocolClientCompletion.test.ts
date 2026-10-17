import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter, getEventListeners } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Emitter } from "@zcode/rpc";
import type { ZCodeProtocolMessage, ZCodeStorageStartupState } from "@zcode/shared";
import {
  ZCodeProtocolClient,
  ZCodeProtocolRequestTimeoutError,
} from "../src/zcode-agent/zcodeProtocolClient.js";
import type {
  ZCodeProtocolTransport,
  ZCodeProtocolTransportClosedEvent,
} from "../src/zcode-agent/zcodeProtocolTransport.js";
import { ZCodeStdioTransport } from "../src/zcode-agent/zcodeStdioTransport.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

// 只推进 Promise continuation，不启动真实时钟、网络或 Agent。
async function flushMicrotasks() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

const fixtures: ReturnType<typeof fixture>[] = [];
function fixture(options?: ConstructorParameters<typeof ZCodeProtocolClient>[1]) {
  const messages = new Emitter<ZCodeProtocolMessage>();
  const closes = new Emitter<ZCodeProtocolTransportClosedEvent>();
  const send = vi.fn<ZCodeProtocolTransport["send"]>(async () => {});
  const dispose = vi.fn();
  const client = new ZCodeProtocolClient(
    { kind: "memory", onMessage: messages.event, onClose: closes.event, send, dispose },
    { requestTimeoutMs: 100, ...options },
  );
  const drained = vi.fn();
  const timeout = vi.fn();
  client.onPendingRequestsDrained(drained);
  client.onRequestTimeout(timeout);
  const instance = { client, messages, closes, send, dispose, drained, timeout };
  fixtures.push(instance);
  return instance;
}

function storage(phase: ZCodeStorageStartupState["phase"], sequence: number): ZCodeProtocolMessage {
  return {
    method: "startup/storageState",
    params: {
      schemaVersion: 1,
      attemptId: "synthetic-attempt",
      databaseId: "synthetic-database",
      databaseKind: "session",
      phase,
      sequence,
      elapsedMs: sequence,
      ...(phase === "failed" ? { errorCode: "sql_failed" } : {}),
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const { client, messages, closes } of fixtures.splice(0)) {
    client.dispose();
    messages.dispose();
    closes.dispose();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("protocol completion while the write callback is pending", () => {
  it("cancels through the production stdio transport while its Writable callback is held", async () => {
    let releaseWrite: (() => void) | undefined;
    const child = Object.assign(new EventEmitter(), {
      stdin: new Writable({
        write(_chunk, _encoding, callback) {
          releaseWrite = callback;
        },
      }),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      killed: false,
      exitCode: null as number | null,
      signalCode: null,
    });
    const transport = new ZCodeStdioTransport(child as unknown as ChildProcessWithoutNullStreams);
    const client = new ZCodeProtocolClient(transport);
    const controller = new AbortController();
    const cancellation = new Error("synthetic stdio cancellation");
    let received: unknown;
    const outcome = client
      .request("v4/hello", {}, undefined, { signal: controller.signal })
      .catch((error: unknown) => {
        received = error;
      });
    try {
      expect(releaseWrite).toBeTypeOf("function");
      controller.abort(cancellation);
      await flushMicrotasks();
      expect(received).toBe(cancellation);
      expect(client.pendingRequestCount).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      releaseWrite?.();
      await outcome;
      // fake child 已退出，dispose 不会走真实进程终止或进程树探测。
      child.exitCode = 0;
      child.stderr.emit("close");
      client.dispose();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  });

  it.each(["abort", "timeout", "close", "dispose", "response"] as const)(
    "%s settles the caller before the transport write completes",
    async (completion) => {
      const { client, messages, closes, send, drained, timeout } = fixture();
      const write = deferred();
      send.mockReturnValue(write.promise);
      const controller = new AbortController();
      const abortError = new Error("synthetic cancellation");
      let settled = false;
      let received: unknown;
      const outcome = client.request("v4/hello", {}, undefined, { signal: controller.signal }).then(
        (value) => {
          settled = true;
          received = value;
        },
        (error: unknown) => {
          settled = true;
          received = error;
        },
      );
      try {
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
        if (completion === "abort") controller.abort(abortError);
        if (completion === "timeout") vi.advanceTimersByTime(100);
        if (completion === "close") closes.fire({ reason: "synthetic close" });
        if (completion === "dispose") client.dispose();
        if (completion === "response") messages.fire({ id: 1, result: "accepted" });
        await flushMicrotasks();
        expect(settled).toBe(true);
        expect(client.pendingRequestCount).toBe(0);
        expect(client.pendingOperationRequestCount).toBe(0);
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
        expect(vi.getTimerCount()).toBe(0);
        expect(drained).toHaveBeenCalledTimes(completion === "dispose" ? 0 : 1);
        expect(timeout).toHaveBeenCalledTimes(completion === "timeout" ? 1 : 0);
        if (completion === "abort") expect(received).toBe(abortError);
        if (completion === "timeout")
          expect(received).toBeInstanceOf(ZCodeProtocolRequestTimeoutError);
        if (completion === "close")
          expect(received).toEqual(new Error("ZCode agent transport closed: synthetic close"));
        if (completion === "dispose")
          expect(received).toEqual(new Error("ZCode Protocol client disposed"));
        if (completion === "response") expect(received).toBe("accepted");
      } finally {
        // 旧实现断言失败时也释放内存写入，确保内部拒绝在本轮微任务内被接住。
        write.resolve();
        await outcome;
      }
    },
  );

  it.each(["abort", "response", "timeout", "close", "dispose"] as const)(
    "ignores a late write rejection after %s without another completion",
    async (completion) => {
      const { client, messages, closes, send, drained } = fixture();
      const write = deferred();
      send.mockReturnValue(write.promise);
      const controller = new AbortController();
      const received: unknown[] = [];
      const outcome = client.request("v4/hello", {}, undefined, { signal: controller.signal }).then(
        (value) => received.push(value),
        (error: unknown) => received.push(error),
      );
      try {
        if (completion === "abort") controller.abort(new Error("cancelled"));
        if (completion === "response") messages.fire({ id: 1, result: "accepted" });
        if (completion === "timeout") vi.advanceTimersByTime(100);
        if (completion === "close") closes.fire({});
        if (completion === "dispose") client.dispose();
        await flushMicrotasks();
        expect(received).toHaveLength(1);
        const firstResult = received[0];
        write.reject(new Error("late write failure"));
        await flushMicrotasks();
        messages.fire({ id: 1, result: "duplicate" });
        expect(received).toEqual([firstResult]);
        expect(drained).toHaveBeenCalledTimes(completion === "dispose" ? 0 : 1);
        expect(client.pendingOperationRequestCount).toBe(0);
      } finally {
        write.resolve();
        await outcome;
      }
    },
  );

  it.each([false, true])(
    "cleans up a send failure (synchronous=%s), preserving its value",
    async (synchronous) => {
      const { client, send, drained } = fixture();
      const failure = { reason: "synthetic transport failure" };
      send.mockImplementation(() => {
        if (synchronous) throw failure;
        return Promise.reject(failure);
      });
      const controller = new AbortController();
      await expect(
        client.request("v4/hello", {}, undefined, { signal: controller.signal }),
      ).rejects.toBe(failure);
      expect(client.pendingRequestCount).toBe(0);
      expect(client.pendingOperationRequestCount).toBe(0);
      expect(drained).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    },
  );

  it("a completed write waits for a validated response", async () => {
    const { client, messages } = fixture();
    let settled = false;
    const outcome = client
      .request("v4/hello", {}, z.string())
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    await flushMicrotasks();
    expect(settled).toBe(false);
    messages.fire({ id: 1, result: 42 });
    expect(await outcome).toBeInstanceOf(z.ZodError);
    expect(client.pendingOperationRequestCount).toBe(0);
  });
});

describe("constant-cost business request accounting", () => {
  it("pre-aborted or disposed calls never enter the pending map or transport", async () => {
    const { client, send, drained } = fixture();
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));
    await expect(
      client.request("v4/hello", {}, undefined, { signal: controller.signal }),
    ).rejects.toThrow("already cancelled");
    client.dispose();
    await expect(client.request("v4/hello")).rejects.toThrow("disposed");
    expect(send).not.toHaveBeenCalled();
    expect(drained).not.toHaveBeenCalled();
    expect(client.pendingOperationRequestCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a protocol error completes one request without draining remaining business work", async () => {
    const { client, messages, drained } = fixture();
    const first = client.request("v4/hello").catch((error: unknown) => error);
    const second = client.request("v4/hello");
    messages.fire({
      id: 1,
      error: { code: 7, message: "synthetic rejection", data: { retryable: false } },
    });
    expect(await first).toMatchObject({
      code: 7,
      message: "synthetic rejection",
      data: { retryable: false },
    });
    expect(client.pendingOperationRequestCount).toBe(1);
    expect(drained).not.toHaveBeenCalled();
    messages.fire({ id: 2, result: "second" });
    expect(await second).toBe("second");
    expect(drained).toHaveBeenCalledTimes(1);
  });

  it("does linear work across a mixed backlog, repeated count reads and out-of-order completion", async () => {
    const { client, messages, drained } = fixture();
    const size = 1024;
    const outcomes = Array.from({ length: size * 2 }, (_, index) =>
      client.request("v4/hello", { index }, undefined, {
        lifecycle: index < size ? "operation" : "observation",
      }),
    );
    // 计量已有 pending 条目的 observation 读取次数；不把它解释为真实 CPU/内存数据。
    const pending = Reflect.get(client, "pending") as Map<string, { observation: boolean }>;
    let reads = 0;
    for (const entry of pending.values()) {
      const observation = entry.observation;
      Object.defineProperty(entry, "observation", {
        get: () => {
          reads += 1;
          return observation;
        },
      });
    }
    for (let remaining = size; remaining > 0; remaining -= 1) {
      expect(client.pendingOperationRequestCount).toBe(remaining);
      messages.fire({ id: remaining, result: remaining });
    }
    expect(client.pendingRequestCount).toBe(size);
    expect(client.pendingOperationRequestCount).toBe(0);
    expect(drained).toHaveBeenCalledTimes(1);
    messages.fire({ id: 1, result: "duplicate" });
    messages.fire({ id: "unknown", result: "ignored" });
    for (let id = size + 1; id <= size * 2; id += 1) messages.fire({ id, result: id });
    await Promise.all(outcomes);
    expect(drained).toHaveBeenCalledTimes(1);
    expect(client.pendingRequestCount).toBe(0);
    expect(reads).toBeLessThanOrEqual(size * 4);
  });

  it("publishes the updated count before a drained listener submits another request", async () => {
    const { client, messages, drained } = fixture();
    let next: Promise<unknown> | undefined;
    const counts: number[] = [];
    client.onPendingRequestsDrained(() => {
      counts.push(client.pendingOperationRequestCount);
      if (!next) next = client.request("v4/hello");
    });
    const first = client.request("v4/hello");
    messages.fire({ id: 1, result: "first" });
    expect(client.pendingOperationRequestCount).toBe(1);
    messages.fire({ id: 2, result: "second" });
    expect(await first).toBe("first");
    expect(await next).toBe("second");
    expect(counts).toEqual([0, 0]);
    expect(drained).toHaveBeenCalledTimes(2);
  });

  it("observation timeout and cancellation neither emit health failure nor renew idle time", async () => {
    const { client, timeout, drained } = fixture();
    const controller = new AbortController();
    const cancelled = client
      .request("v4/hello", {}, undefined, { lifecycle: "observation", signal: controller.signal })
      .catch((error: unknown) => error);
    const expired = client
      .request("v4/hello", {}, undefined, { lifecycle: "observation" })
      .catch((error: unknown) => error);
    controller.abort();
    vi.advanceTimersByTime(100);
    await Promise.all([cancelled, expired]);
    expect(client.pendingOperationRequestCount).toBe(0);
    expect(client.pendingRequestCount).toBe(0);
    expect(timeout).not.toHaveBeenCalled();
    expect(drained).not.toHaveBeenCalled();
  });

  it("bulk close resets both counts before notifying, and ignores duplicate terminal signals", async () => {
    const { client, messages, closes, drained } = fixture();
    const outcomes = [
      client.request("v4/hello"),
      client.request("v4/hello"),
      client.request("v4/hello", {}, undefined, { lifecycle: "observation" }),
    ].map((request) => request.catch((error: unknown) => error));
    const counts: number[][] = [];
    client.onPendingRequestsDrained(() =>
      counts.push([client.pendingRequestCount, client.pendingOperationRequestCount]),
    );
    closes.fire({});
    closes.fire({});
    messages.fire({ id: 1, error: { code: 1, message: "late" } });
    expect(await Promise.all(outcomes)).toHaveLength(3);
    expect(counts).toEqual([[0, 0]]);
    expect(drained).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("storage startup keeps its existing admission and watchdog boundaries", () => {
  it("does not send before ready and does not send an aborted waiter", async () => {
    const { client, messages, send } = fixture({ requireStorageStartup: true });
    const controller = new AbortController();
    const cancelled = client
      .request("v4/hello", {}, undefined, { signal: controller.signal })
      .catch((error: unknown) => error);
    const outcome = client.request("v4/hello");
    controller.abort(new Error("cancelled before ready"));
    await cancelled;
    expect(send).not.toHaveBeenCalled();
    expect(client.pendingRequestCount).toBe(0);
    messages.fire(storage("ready", 1));
    await flushMicrotasks();
    expect(send).toHaveBeenCalledTimes(1);
    expect(client.pendingOperationRequestCount).toBe(1);
    messages.fire({ id: 1, result: "ready" });
    expect(await outcome).toBe("ready");
  });

  it("pauses an already admitted watchdog during migration and resumes it at ready", async () => {
    const { client, messages, timeout } = fixture();
    const outcome = client.request("v4/hello").catch((error: unknown) => error);
    messages.fire(storage("migrating", 1));
    vi.advanceTimersByTime(1000);
    expect(client.pendingOperationRequestCount).toBe(1);
    expect(timeout).not.toHaveBeenCalled();
    messages.fire(storage("ready", 2));
    vi.advanceTimersByTime(99);
    expect(timeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(await outcome).toBeInstanceOf(ZCodeProtocolRequestTimeoutError);
    expect(client.pendingOperationRequestCount).toBe(0);
    expect(timeout).toHaveBeenCalledTimes(1);
  });

  it("startup failure clears admitted requests and prevents later admission", async () => {
    const { client, messages, send, drained } = fixture();
    const outcome = client.request("v4/hello").catch((error: unknown) => error);
    messages.fire(storage("failed", 1));
    expect(await outcome).toEqual(new Error("SQLite startup failed: sql_failed"));
    await expect(client.request("v4/hello")).rejects.toThrow("SQLite startup failed");
    expect(send).toHaveBeenCalledTimes(1);
    expect(client.pendingOperationRequestCount).toBe(0);
    expect(drained).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
