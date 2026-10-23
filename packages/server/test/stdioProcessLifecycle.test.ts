import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceCollection } from "@zcode/services";
import { createStdioTransport } from "../src/stdio.js";
import { waitForStdioAck } from "../src/stdio-ack.js";
import { registerStdioProcessLifecycle, startStdioProcess } from "../src/stdio-lifecycle.js";

afterEach(() => vi.useRealTimers());

async function flushShutdown(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function lifecycleFixture(stdin = new PassThrough()) {
  const signalSource = new EventEmitter();
  const events: string[] = [];
  const stopRpc = vi.fn(async () => {
    events.push("stop");
  });
  const dispose = vi.fn(async () => {
    events.push("dispose");
  });
  const exit = vi.fn((code: number) => {
    events.push(`exit:${code}`);
  });
  return {
    stdin,
    signalSource,
    events,
    stopRpc,
    dispose,
    exit,
    log: vi.fn(),
    rpcStopTimeoutMs: 50,
    serviceDisposeTimeoutMs: 50,
  };
}

describe("stdio process lifecycle", () => {
  it.each([false, true])(
    "observes EOF during preparation after a paused ACK with RPC suffix=%s",
    async (withSuffix) => {
      const f = lifecycleFixture();
      const stdout = new PassThrough();
      const input = vi
        .spyOn(process, "stdin", "get")
        .mockReturnValue(f.stdin as unknown as typeof process.stdin);
      const output = vi
        .spyOn(process, "stdout", "get")
        .mockReturnValue(stdout as unknown as typeof process.stdout);
      const ack = waitForStdioAck(f.stdin);
      const suffix = Buffer.alloc(164, 0x61);
      suffix.fill(0, 0, 13);
      suffix[0] = 1;
      suffix.writeUInt32BE(151, 9);
      f.stdin.write(
        Buffer.concat([
          Buffer.from(
            `${JSON.stringify({ type: "zcode-hello-ack", version: "fixture", clientId: "fixture" })}\n`,
          ),
          withSuffix ? suffix : Buffer.alloc(0),
        ]),
      );
      await ack;
      expect(f.stdin.isPaused()).toBe(true);
      let resolvePrepared!: (value: string) => void;
      const prepared = new Promise<string>((resolve) => {
        resolvePrepared = resolve;
      });
      const createRuntime = vi.fn(
        (_prepared: string, transport: ReturnType<typeof createStdioTransport>) => {
          transport.attachServices(new ServiceCollection());
          return { stopRpc: transport.stop, ready: transport.ready, dispose: f.dispose };
        },
      );
      const ready = vi.fn();
      const starting = startStdioProcess({
        ...f,
        createTransport: createStdioTransport,
        prepare: () => prepared,
        createRuntime,
        ready,
      });
      try {
        // 生产 ACK 已 pause；这里绝不手动 resume，以覆盖带后缀时 end 被未消费字节阻挡的真实链路。
        f.stdin.end();
        await flushShutdown();
        await flushShutdown();
        expect(f.exit).toHaveBeenCalledExactlyOnceWith(0);
        resolvePrepared("fixture config");
        await starting;
        expect(createRuntime).not.toHaveBeenCalled();
        expect(ready).not.toHaveBeenCalled();
      } finally {
        f.stdin.destroy();
        await flushShutdown();
        resolvePrepared("fixture config");
        await starting;
        input.mockRestore();
        output.mockRestore();
        stdout.destroy();
      }
    },
  );

  it.each(["stop", "dispose"] as const)(
    "continues cleanup and exits once when %s throws synchronously",
    async (phase) => {
      const f = lifecycleFixture();
      const error = new Error(`fixture synchronous ${phase} failure`);
      if (phase === "stop")
        f.stopRpc.mockImplementation(() => {
          throw error;
        });
      else
        f.dispose.mockImplementation(() => {
          throw error;
        });
      registerStdioProcessLifecycle(f);
      try {
        f.stdin.emit("end");
        expect(f.stopRpc).toHaveBeenCalledOnce();
        await flushShutdown();
        expect(f.dispose).toHaveBeenCalledOnce();
        expect(f.exit).toHaveBeenCalledExactlyOnceWith(1);
        expect(f.log).toHaveBeenCalledWith(
          phase === "stop" ? "stdio shutdown RPC stop failed" : "stdio shutdown cleanup failed",
          error,
        );
      } finally {
        f.stdin.destroy();
      }
    },
  );

  it.each(["prepare", "create"] as const)(
    "uses the same shutdown promise after %s fails once transport is owned",
    async (phase) => {
      const f = lifecycleFixture();
      const stop = vi.fn(async () => {
        f.events.push("transport-stop");
      });
      const ready = vi.fn();
      const error = new Error(`fixture ${phase} failure`);
      await startStdioProcess({
        ...f,
        createTransport: () => ({ stop }),
        prepare: () => (phase === "prepare" ? Promise.reject(error) : Promise.resolve("config")),
        createRuntime: () => {
          throw error;
        },
        ready,
      });
      expect(stop).toHaveBeenCalledOnce();
      expect(ready).not.toHaveBeenCalled();
      expect(f.exit).toHaveBeenCalledExactlyOnceWith(1);
      expect(f.log).toHaveBeenCalledWith("stdio startup failed", error);
      f.stdin.destroy();
    },
  );

  it("reclaims the owned runtime when service binding or ready throws", async () => {
    const f = lifecycleFixture();
    const error = new Error("fixture binding failure");
    const ready = vi.fn();
    await startStdioProcess({
      ...f,
      prepare: async () => "config",
      createRuntime: () => ({
        stopRpc: f.stopRpc,
        dispose: f.dispose,
        ready: () => {
          throw error;
        },
      }),
      ready,
    });
    expect(f.events).toEqual(["stop", "dispose", "exit:1"]);
    expect(ready).not.toHaveBeenCalled();
    expect(f.log).toHaveBeenCalledWith("stdio startup failed", error);
    f.stdin.destroy();
  });

  it("does not prepare or create resources when registered against destroyed stdin", async () => {
    const f = lifecycleFixture();
    const closed = once(f.stdin, "close");
    f.stdin.destroy();
    await closed;
    const prepare = vi.fn(async () => "fixture config");
    const createRuntime = vi.fn(() => ({ stopRpc: f.stopRpc, dispose: f.dispose }));
    const ready = vi.fn();
    await startStdioProcess({ ...f, prepare, createRuntime, ready });
    await flushShutdown();
    expect(prepare).not.toHaveBeenCalled();
    expect(createRuntime).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("promotes the exit code on repeated error or signals without repeating cleanup", async () => {
    const f = lifecycleFixture();
    let finishStop!: () => void;
    f.stopRpc.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishStop = resolve;
        }),
    );
    const lifecycle = registerStdioProcessLifecycle(f);
    try {
      f.stdin.emit("end");
      expect(lifecycle.shutdownStarted).toBe(true);
      expect(f.stopRpc).toHaveBeenCalledOnce();
      f.stdin.emit("error", new Error("fixture late error"));
      f.signalSource.emit("SIGHUP");
      f.signalSource.emit("SIGTERM");
      f.signalSource.emit("SIGINT");
      finishStop();
      await flushShutdown();
      expect(f.stopRpc).toHaveBeenCalledOnce();
      expect(f.dispose).toHaveBeenCalledOnce();
      expect(f.exit).toHaveBeenCalledExactlyOnceWith(1);
    } finally {
      f.stdin.destroy();
    }
  });

  it.each(["stop", "dispose"] as const)(
    "keeps the existing bounded cleanup when %s never resolves",
    async (phase) => {
      vi.useFakeTimers();
      const f = lifecycleFixture();
      const pending = () => new Promise<void>(() => {});
      if (phase === "stop") f.stopRpc.mockImplementation(pending);
      else f.dispose.mockImplementation(pending);
      registerStdioProcessLifecycle(f);
      try {
        f.stdin.emit("end");
        await vi.advanceTimersByTimeAsync(100);
        expect(f.stopRpc).toHaveBeenCalledOnce();
        expect(f.dispose).toHaveBeenCalledOnce();
        expect(f.exit).toHaveBeenCalledExactlyOnceWith(1);
        expect(vi.getTimerCount()).toBe(0);
        expect(f.log).toHaveBeenCalledWith("stdio shutdown timed out", {
          phase: phase === "stop" ? "rpc-stop" : "service-dispose",
          timeoutMs: 50,
        });
      } finally {
        f.stdin.destroy();
      }
    },
  );

  it.each(["end", "close", "error"] as const)(
    "shuts down during preparation on %s and ignores the late result",
    async (event) => {
      const f = lifecycleFixture();
      f.stdin.on("error", () => {});
      let resolvePrepared!: (value: string) => void;
      const prepared = new Promise<string>((resolve) => {
        resolvePrepared = resolve;
      });
      const createRuntime = vi.fn(() => ({ stopRpc: f.stopRpc, dispose: f.dispose }));
      const ready = vi.fn();
      const starting = startStdioProcess({
        ...f,
        prepare: () => prepared,
        createRuntime,
        ready,
      });
      try {
        const terminal = once(f.stdin, event).catch(() => undefined);
        if (event === "end") {
          f.stdin.resume();
          f.stdin.end();
        } else {
          f.stdin.destroy(event === "error" ? new Error("fixture preparation failure") : undefined);
        }
        await terminal;
        await flushShutdown();
        expect(f.exit).toHaveBeenCalledExactlyOnceWith(event === "error" ? 1 : 0);
        expect(createRuntime).not.toHaveBeenCalled();
        resolvePrepared("fixture config");
        await starting;
        expect(createRuntime).not.toHaveBeenCalled();
        expect(ready).not.toHaveBeenCalled();
        expect(f.stopRpc).not.toHaveBeenCalled();
        expect(f.dispose).not.toHaveBeenCalled();
      } finally {
        resolvePrepared("fixture config");
        await starting;
        f.stdin.destroy();
      }
    },
  );

  it("reclaims a runtime returned after synchronous close without publishing ready", async () => {
    const f = lifecycleFixture();
    const ready = vi.fn();
    const starting = startStdioProcess({
      ...f,
      prepare: async () => "fixture config",
      createRuntime: () => {
        f.events.push("create");
        f.stdin.emit("close");
        expect(f.stopRpc).not.toHaveBeenCalled();
        f.events.push("return");
        return { stopRpc: f.stopRpc, dispose: f.dispose };
      },
      ready,
    });
    try {
      await starting;
      await flushShutdown();
      expect(f.events).toEqual(["create", "return", "stop", "dispose", "exit:0"]);
      expect(ready).not.toHaveBeenCalled();
    } finally {
      f.stdin.destroy();
    }
  });

  it("starts normally and stops RPC synchronously after ready", async () => {
    const f = lifecycleFixture();
    const ready = vi.fn();
    try {
      await startStdioProcess({
        ...f,
        prepare: async () => "fixture config",
        createRuntime: () => ({ stopRpc: f.stopRpc, dispose: f.dispose }),
        ready,
      });
      expect(ready).toHaveBeenCalledOnce();
      f.stdin.emit("end");
      expect(f.stopRpc).toHaveBeenCalledOnce();
      await flushShutdown();
      expect(f.events).toEqual(["stop", "dispose", "exit:0"]);
    } finally {
      f.stdin.destroy();
    }
  });

  it("starts stop synchronously and disposes once on normal EOF", async () => {
    const f = lifecycleFixture();
    registerStdioProcessLifecycle(f);
    try {
      f.stdin.emit("end");
      expect(f.stopRpc).toHaveBeenCalledOnce();
      f.stdin.emit("end");
      await flushShutdown();
      expect(f.events).toEqual(["stop", "dispose", "exit:0"]);
      expect(f.exit).toHaveBeenCalledOnce();
    } finally {
      f.stdin.destroy();
    }
  });

  it.each(["ended", "destroyed", "errored"] as const)(
    "shuts down once when stdin was already %s before registration",
    async (kind) => {
      const f = lifecycleFixture();
      f.stdin.on("error", () => {});
      if (kind === "ended") {
        f.stdin.resume();
        const ended = once(f.stdin, "end");
        f.stdin.end();
        await ended;
      } else {
        const closed = once(f.stdin, "close").catch(() => undefined);
        f.stdin.destroy(kind === "errored" ? new Error("fixture stdin failure") : undefined);
        await closed;
      }
      try {
        registerStdioProcessLifecycle(f);
        await flushShutdown();
        expect(f.stopRpc).toHaveBeenCalledOnce();
        expect(f.dispose).toHaveBeenCalledOnce();
        expect(f.events).toEqual(["stop", "dispose", `exit:${kind === "errored" ? 1 : 0}`]);
        f.stdin.emit("end");
        f.stdin.emit("close");
        await flushShutdown();
        expect(f.exit).toHaveBeenCalledOnce();
      } finally {
        f.stdin.destroy();
      }
    },
  );

  it("treats close without end as a terminal stream", async () => {
    const f = lifecycleFixture();
    registerStdioProcessLifecycle(f);
    const closed = once(f.stdin, "close");
    f.stdin.destroy();
    await closed;
    await flushShutdown();
    expect(f.events).toEqual(["stop", "dispose", "exit:0"]);
  });
});
