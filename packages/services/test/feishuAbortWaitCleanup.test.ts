import { getEventListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFeishuChannelRuntime } from "../src/bots/feishuChannelRuntime.js";

const mocks = vi.hoisted(() => ({ acquire: vi.fn(), start: vi.fn() }));
vi.mock("../src/bots/channelRuntime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/bots/channelRuntime.js")>()),
  acquireFeishuWebSocketLock: mocks.acquire,
}));
vi.mock("../src/bots/providers/feishuProvider.js", () => ({
  startFeishuBotWebSocket: mocks.start,
}));
beforeEach(() => {
  vi.useFakeTimers();
  mocks.acquire.mockReset();
  mocks.start.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
async function flush() {
  for (let index = 0; index < 25; index++) await Promise.resolve();
}

function fixture() {
  const signals = new Set<AbortSignal>();
  const add = AbortSignal.prototype.addEventListener;
  vi.spyOn(AbortSignal.prototype, "addEventListener").mockImplementation(function (
    this: AbortSignal,
    ...args
  ) {
    if (args[0] === "abort") signals.add(this);
    return add.apply(this, args);
  });
  const attempts: {
    resolve: () => void;
    reject: (error: Error) => void;
    close: ReturnType<typeof vi.fn>;
    signal: AbortSignal;
  }[] = [];
  const release = vi.fn(async () => {});
  mocks.acquire.mockResolvedValue({ release });
  mocks.start.mockImplementation(async ({ signal }: { signal: AbortSignal }) => {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const terminated = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    const close = vi.fn(resolve);
    attempts.push({ resolve, reject, close, signal });
    return { terminated, close };
  });
  const status = vi.fn();
  const config = {
    bots: [
      {
        id: "synthetic",
        provider: "feishu",
        enabled: true,
        credentialRef: "synthetic-ref",
        feishuAppId: "synthetic-app",
      },
    ],
  };
  const runtime = createFeishuChannelRuntime({
    credentialService: { load: async () => "synthetic-value" },
    logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() },
    statusSink: { getRuntimeStatus: () => undefined, setRuntimeStatus: status },
    ensureBotStorageMigrated: async () => {},
    readConfig: async () => config,
    summarizeCallbackPayload: () => "synthetic",
    processProviderCallback: vi.fn(),
  } as unknown as Parameters<typeof createFeishuChannelRuntime>[0]);
  return {
    runtime,
    attempts,
    release,
    status,
    listeners: () =>
      [...signals].reduce((sum, signal) => sum + getEventListeners(signal, "abort").length, 0),
  };
}

describe("Feishu reconnect abort wait lifecycle", () => {
  it.each([false, true])("stops without another connection during backoff=%s", async (backoff) => {
    const f = fixture();
    try {
      await f.runtime.refresh();
      await flush();
      if (backoff) {
        f.attempts[0]!.reject(new Error("synthetic disconnect"));
        await flush();
        expect(vi.getTimerCount()).toBe(1);
      }
      await f.runtime.stopWebSocket("synthetic");
      expect(f.attempts[0]!.signal.aborted).toBe(true);
      expect(f.attempts[0]!.close).toHaveBeenCalledOnce();
      expect(f.release).toHaveBeenCalledOnce();
      expect(f.listeners()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(5000);
      expect(f.attempts).toHaveLength(1);
    } finally {
      await f.runtime.dispose();
    }
  });

  it("does not retain a failed attempt's listener across repeated backoffs", async () => {
    const f = fixture();
    try {
      await f.runtime.refresh();
      await flush();
      const counts: number[] = [];
      for (let index = 0; index < 8; index++) {
        const attempt = f.attempts[index]!;
        attempt.reject(new Error(`synthetic-${index}`));
        await flush();
        expect(attempt.close).toHaveBeenCalledOnce();
        expect(f.release).toHaveBeenCalledTimes(index + 1);
        expect(attempt.signal.aborted).toBe(false);
        expect(vi.getTimerCount()).toBe(1);
        counts.push(f.listeners());
        await vi.advanceTimersByTimeAsync(4999);
        expect(f.attempts).toHaveLength(index + 1);
        await vi.advanceTimersByTimeAsync(1);
        expect(f.attempts).toHaveLength(index + 2);
      }
      expect(counts).toEqual(Array(8).fill(1));
    } finally {
      await f.runtime.dispose();
    }
    expect(f.listeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves immediate restart on normal termination and disposes the current attempt", async () => {
    const f = fixture();
    try {
      await f.runtime.refresh();
      await flush();
      f.attempts[0]!.resolve();
      await flush();
      expect(f.attempts).toHaveLength(2);
      expect(f.attempts[0]!.close).toHaveBeenCalledOnce();
      expect(f.release).toHaveBeenCalledOnce();
      expect(f.attempts[1]!.signal.aborted).toBe(false);
      expect(f.listeners()).toBe(1);
    } finally {
      await f.runtime.dispose();
    }
    expect(f.attempts[1]!.close).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledTimes(2);
    expect(f.listeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
