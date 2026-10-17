import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGitCommandProvider } from "../src/git/providers/gitCommandProvider.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const spawnMock = vi.mocked(spawn);

function fakeChild() {
  return Object.assign(new EventEmitter(), {
    pid: 12345,
    stdout: Object.assign(new EventEmitter(), { destroy: vi.fn() }),
    stderr: Object.assign(new EventEmitter(), { destroy: vi.fn() }),
    kill: vi.fn((_signal?: NodeJS.Signals) => true),
    unref: vi.fn(),
  });
}

async function start(options?: Parameters<typeof createGitCommandProvider>[0]) {
  const child = fakeChild();
  spawnMock.mockReturnValueOnce(child as unknown as ChildProcess);
  const provider = createGitCommandProvider({
    environmentProvider: {
      resolveGitBinary: async () => "synthetic-git",
      createCommandEnv: () => ({ SYNTHETIC_BASE: "base", SYNTHETIC_OVERRIDE: "old" }),
    },
    platform: "darwin",
    ...options,
  });
  const result = provider.run({
    cwd: "synthetic-workspace",
    args: ["status", "--porcelain"],
    timeoutMs: 100,
    maxOutputBytes: 16_384,
    env: { SYNTHETIC_OVERRIDE: "new" },
  });
  // 仅等待环境发现的 Promise，不启动真实子进程或轮询真实时钟。
  await Promise.resolve();
  return { child, result };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  spawnMock.mockReset();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("Git command timeout stage cleanup", () => {
  it.each(["close", "error"] as const)("keeps ordinary %s results and cleanup", async (event) => {
    const { child, result } = await start();
    expect(spawnMock).toHaveBeenCalledWith("synthetic-git", ["status", "--porcelain"], {
      cwd: "synthetic-workspace",
      env: { SYNTHETIC_BASE: "base", SYNTHETIC_OVERRIDE: "new" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout.emit("data", Buffer.from("状态\n"));
    child.stderr.emit("data", Buffer.from("diagnostic"));
    await vi.advanceTimersByTimeAsync(17);
    if (event === "close") child.emit("close", 0, null);
    else child.emit("error", new Error("synthetic spawn failure"));
    expect(await result).toMatchObject({
      stdout: "状态\n",
      stderr: event === "close" ? "diagnostic" : "synthetic spawn failure",
      exitCode: event === "close" ? 0 : -2,
      signal: null,
      durationMs: 17,
      timedOut: false,
      timeoutElapsedMs: undefined,
      timeoutCloseDelayMs: undefined,
      forceKillAttempted: false,
      orphaned: false,
      outputTruncated: false,
    });
    expect(child.kill).not.toHaveBeenCalled();
    expect(child.listenerCount("close")).toBe(0);
    expect(child.listenerCount("error")).toBe(0);
    expect(child.stdout.listenerCount("data")).toBe(0);
    expect(child.stderr.listenerCount("data")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["soft", "close"],
    ["soft", "error"],
    ["forced", "close"],
    ["forced", "error"],
  ] as const)("releases the %s grace timer on %s", async (phase, event) => {
    const { child, result } = await start();
    const elapsed = phase === "soft" ? 107 : 2_107;
    await vi.advanceTimersByTimeAsync(elapsed);
    expect(vi.getTimerCount()).toBe(1);
    if (event === "close") child.emit("close", null, "SIGTERM");
    else child.emit("error", new Error("synthetic kill failure"));
    expect(await result).toMatchObject({
      exitCode: event === "close" ? null : -2,
      signal: event === "close" ? "SIGTERM" : null,
      durationMs: elapsed,
      timedOut: true,
      timeoutElapsedMs: 100,
      timeoutCloseDelayMs: elapsed - 100,
      forceKillAttempted: phase === "forced",
      orphaned: false,
    });
    expect(child.kill).toHaveBeenCalledTimes(phase === "soft" ? 1 : 2);
    expect(child.stdout.destroy).not.toHaveBeenCalled();
    expect(child.unref).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await vi.runAllTimersAsync();
    expect(child.kill).toHaveBeenCalledTimes(phase === "soft" ? 1 : 2);
  });

  it.each(["soft", "forced"] as const)(
    "retains no timers after 256 commands complete in the %s grace period",
    async (phase) => {
      const commands = await Promise.all(Array.from({ length: 256 }, () => start()));
      for (const { child } of commands) child.stdout.emit("data", Buffer.alloc(16_384, "x"));
      await vi.advanceTimersByTimeAsync(phase === "soft" ? 101 : 2_101);
      expect(vi.getTimerCount()).toBe(256);
      for (const { child } of commands) child.emit("close", null, "SIGTERM");
      const results = await Promise.all(commands.map(({ result }) => result));
      expect(results).toHaveLength(256);
      expect(
        results.every(
          (result) =>
            result.timedOut &&
            !result.orphaned &&
            result.stdout.length === 16_384 &&
            result.forceKillAttempted === (phase === "forced"),
        ),
      ).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    ["soft", "close"],
    ["soft", "error"],
    ["forced", "close"],
    ["forced", "error"],
  ] as const)("does not rearm after %s kill synchronously emits %s", async (phase, event) => {
    const { child, result } = await start();
    child.kill.mockImplementation((signal) => {
      if ((signal === "SIGKILL") === (phase === "forced")) {
        if (event === "close") child.emit("close", null, signal ?? "SIGTERM");
        else child.emit("error", new Error("synthetic synchronous kill failure"));
      }
      return true;
    });
    await vi.advanceTimersByTimeAsync(phase === "soft" ? 100 : 2_100);
    expect(await result).toMatchObject({
      timedOut: true,
      forceKillAttempted: phase === "forced",
      orphaned: false,
      exitCode: event === "close" ? null : -2,
    });
    expect(vi.getTimerCount()).toBe(0);
    await vi.runAllTimersAsync();
    expect(child.kill).toHaveBeenCalledTimes(phase === "soft" ? 1 : 2);
  });

  it("preserves both custom grace deadlines and orphan cleanup", async () => {
    const { child, result } = await start({ timeoutKillGraceMs: 37, timeoutForceKillGraceMs: 53 });
    const completed = vi.fn();
    void result.then(completed);
    await vi.advanceTimersByTimeAsync(99);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill.mock.calls).toEqual([[]]);
    await vi.advanceTimersByTimeAsync(36);
    expect(child.kill).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill.mock.calls).toEqual([[], ["SIGKILL"]]);
    await vi.advanceTimersByTimeAsync(52);
    expect(completed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({
      exitCode: null,
      signal: null,
      durationMs: 190,
      timedOut: true,
      timeoutElapsedMs: 100,
      timeoutCloseDelayMs: 90,
      forceKillAttempted: true,
      orphaned: true,
    });
    expect(child.stdout.destroy).toHaveBeenCalledOnce();
    expect(child.stderr.destroy).toHaveBeenCalledOnce();
    expect(child.unref).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    child.emit("close", 0, null);
    await vi.runAllTimersAsync();
    expect(completed).toHaveBeenCalledOnce();
  });

  it("keeps per-command timers isolated when another command completes", async () => {
    const first = await start();
    await vi.advanceTimersByTimeAsync(50);
    const second = await start();
    await vi.advanceTimersByTimeAsync(51);
    first.child.emit("close", null, "SIGTERM");
    await first.result;
    expect(vi.getTimerCount()).toBe(1);
    expect(second.child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(49);
    expect(second.child.kill).toHaveBeenCalledOnce();
    second.child.emit("close", null, "SIGTERM");
    expect(await second.result).toMatchObject({ timedOut: true, timeoutElapsedMs: 100 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains truncation semantics without a pending timer after close", async () => {
    const { child, result } = await start();
    child.stdout.emit("data", Buffer.from("prefix"));
    child.stderr.emit("data", Buffer.from("diagnostic"));
    child.stdout.emit("data", Buffer.alloc(16_384));
    child.stdout.emit("data", Buffer.from("ignored"));
    expect(child.kill).toHaveBeenCalledOnce();
    child.emit("close", null, "SIGTERM");
    expect(await result).toMatchObject({
      stdout: "prefix",
      stderr: "diagnostic",
      timedOut: false,
      outputTruncated: true,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["close", "error", "timeout"] as const)(
    "keeps Windows taskkill cleanup independent until its own %s",
    async (event) => {
      const { child, result } = await start({ platform: "win32" });
      const killer = fakeChild();
      spawnMock.mockReturnValueOnce(killer as unknown as ChildProcess);
      await vi.advanceTimersByTimeAsync(2_100);
      expect(spawnMock).toHaveBeenLastCalledWith("taskkill", ["/PID", "12345", "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      expect(vi.getTimerCount()).toBe(2);
      child.emit("close", null, "SIGTERM");
      expect(await result).toMatchObject({ forceKillAttempted: true, orphaned: false });
      // Git 已结束时只能释放自己的阶段计时器，taskkill 仍须保留有界收尾。
      expect(vi.getTimerCount()).toBe(1);
      if (event === "close") killer.emit("close", 0, null);
      else if (event === "error") killer.emit("error", new Error("synthetic taskkill failure"));
      else {
        await vi.advanceTimersByTimeAsync(1_999);
        expect(killer.kill).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(killer.kill).toHaveBeenCalledOnce();
        killer.emit("close", 0, null);
      }
      expect(vi.getTimerCount()).toBe(0);
      await vi.runAllTimersAsync();
      expect(killer.kill).toHaveBeenCalledTimes(event === "timeout" ? 1 : 0);
      expect(child.kill).toHaveBeenCalledOnce();
      expect(spawnMock).toHaveBeenCalledTimes(2);
    },
  );
});
