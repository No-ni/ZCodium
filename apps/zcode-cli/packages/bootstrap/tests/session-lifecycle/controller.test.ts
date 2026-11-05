import { describe, expect, it, vi } from "vitest";
import { SessionLifecycleController } from "../../src/session-lifecycle/index.js";

function fixture() {
  const runtimes = new Set<string>();
  const known = new Set(["a", "b"]);
  const host = {
    exists: vi.fn(async (id: string) => known.has(id)),
    hasRuntime: (id: string) => runtimes.has(id),
    activate: vi.fn(async (id: string) => {
      runtimes.add(id);
    }),
    assertCanStop: vi.fn(),
    release: vi.fn(async (id: string) => {
      runtimes.delete(id);
    }),
    onChange: vi.fn(),
  };
  return { host, runtimes, known, lifecycle: new SessionLifecycleController(host) };
}

describe("session runtime lifecycle", () => {
  it("owns resident resume effects until completion without recreating the instance", async () => {
    const { lifecycle, host } = fixture();
    await lifecycle.ensureReady("a");
    const gate = Promise.withResolvers<void>();
    const refresh = vi.fn(async () => gate.promise);
    const activate = vi.fn(async () => {});
    const resumed = lifecycle.initialize("a", activate, refresh);
    await expect(lifecycle.stop("a")).rejects.toMatchObject({ code: "conflict" });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(activate).not.toHaveBeenCalled();
    gate.resolve();
    await resumed;
    await lifecycle.stop("a");
    expect(host.activate).toHaveBeenCalledTimes(1);
  });

  it("serializes imported-history replacement through full release before initialization", async () => {
    const { lifecycle, host, known, runtimes } = fixture();
    await lifecycle.ensureReady("a");
    known.delete("a"); // 软删行的重新导入由产品入口授权，公开 restart 仍拒绝它。
    await expect(lifecycle.restart("a")).rejects.toMatchObject({ code: "sessionNotFound" });
    const gate = Promise.withResolvers<void>();
    host.release.mockImplementation(async (id) => {
      await gate.promise;
      runtimes.delete(id);
    });
    const activate = vi.fn(async () => {
      expect(runtimes.has("a")).toBe(false);
      runtimes.add("a");
    });
    const replacing = lifecycle.reinitialize("a", activate);
    await expect(lifecycle.reinitialize("a", activate)).rejects.toMatchObject({ code: "conflict" });
    await expect(lifecycle.stop("a")).rejects.toMatchObject({ code: "conflict" });
    expect(activate).not.toHaveBeenCalled();
    gate.resolve();
    await replacing;
    expect(host.release).toHaveBeenCalledTimes(1);
    expect(activate).toHaveBeenCalledTimes(1);
    await lifecycle.initialize("a", activate);
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it("refreshes a resident resume after joining an in-flight ready check", async () => {
    const { lifecycle, host } = fixture();
    await lifecycle.ensureReady("a");
    const gate = Promise.withResolvers<void>();
    host.exists.mockImplementationOnce(async () => {
      await gate.promise;
      return true;
    });
    const checking = lifecycle.ensureReady("a");
    const refresh = vi.fn(async () => {});
    const resumed = lifecycle.initialize("a", async () => {}, refresh);
    expect(refresh).not.toHaveBeenCalled();
    gate.resolve();
    await Promise.all([checking, resumed]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(host.activate).toHaveBeenCalledTimes(1);
  });

  it("does not treat a deleted persistent session as ready even if its old runtime remains", async () => {
    const { lifecycle, known } = fixture();
    await lifecycle.ensureReady("a");
    known.delete("a");
    await expect(lifecycle.ensureReady("a")).rejects.toMatchObject({ code: "sessionNotFound" });
  });
  it("queries without activating and rejects unknown identities", async () => {
    const { lifecycle, host } = fixture();
    expect(await lifecycle.getState("a")).toMatchObject({
      sessionId: "a",
      state: "unloaded",
      lastError: null,
    });
    await expect(lifecycle.getState("missing")).rejects.toMatchObject({ code: "sessionNotFound" });
    expect(host.activate).not.toHaveBeenCalled();
  });

  it("joins concurrent startup and does not expose a registered partial instance as ready", async () => {
    const { lifecycle, host, runtimes } = fixture();
    const gate = Promise.withResolvers<void>();
    host.activate.mockImplementation(async (id) => {
      runtimes.add(id);
      await gate.promise;
    });
    const first = lifecycle.ensureReady("a");
    const second = lifecycle.ensureReady("a");
    expect((await lifecycle.getState("a")).state).toBe("starting");
    gate.resolve();
    await Promise.all([first, second]);
    await lifecycle.ensureReady("a");
    expect(host.activate).toHaveBeenCalledTimes(1);
    expect((await lifecycle.getState("a")).state).toBe("ready");
  });

  it("waits for real release before recreating and joins duplicate stops", async () => {
    const { lifecycle, host, runtimes } = fixture();
    await lifecycle.ensureReady("a");
    const gate = Promise.withResolvers<void>();
    host.release.mockImplementation(async (id) => {
      runtimes.delete(id);
      await gate.promise;
    });
    const stop = lifecycle.stop("a");
    const duplicate = lifecycle.stop("a");
    const ready = lifecycle.ensureReady("a");
    expect((await lifecycle.getState("a")).state).toBe("stopping");
    expect(host.activate).toHaveBeenCalledTimes(1);
    gate.resolve();
    await Promise.all([stop, duplicate, ready]);
    expect(host.release).toHaveBeenCalledTimes(1);
    expect(host.activate).toHaveBeenCalledTimes(2);
  });

  it("owns the whole restart including its unloaded interval", async () => {
    const { lifecycle, host } = fixture();
    await lifecycle.ensureReady("a");
    const gate = Promise.withResolvers<void>();
    host.release.mockImplementation(async () => gate.promise);
    const restart = lifecycle.restart("a");
    const duplicate = lifecycle.restart("a");
    const ready = lifecycle.ensureReady("a");
    await expect(lifecycle.stop("a")).rejects.toMatchObject({ code: "conflict" });
    gate.resolve();
    await Promise.all([restart, duplicate, ready]);
    expect(host.release).toHaveBeenCalledTimes(1);
    expect(host.activate).toHaveBeenCalledTimes(2);
  });

  it("coalesces restart during startup without overlapping instances", async () => {
    const { lifecycle, host } = fixture();
    const gate = Promise.withResolvers<void>();
    host.activate.mockImplementation(async (id) => {
      if (id === "a") await gate.promise;
    });
    const pending = lifecycle.ensureReady("a");
    await expect(lifecycle.stop("a")).rejects.toMatchObject({ code: "conflict" });
    const restarting = lifecycle.restart("a");
    const duplicate = lifecycle.restart("a");
    expect(host.release).not.toHaveBeenCalled();
    await lifecycle.ensureReady("b");
    expect((await lifecycle.getState("b")).state).toBe("ready");
    gate.resolve();
    await pending;
    await Promise.all([restarting, duplicate]);
    expect(host.activate.mock.calls.filter(([id]) => id === "a")).toHaveLength(2);
    expect(host.release).toHaveBeenCalledTimes(1);
  });

  it("reserves restart before earlier startup observers can stop the runtime", async () => {
    const { lifecycle, host } = fixture();
    const gate = Promise.withResolvers<void>();
    host.activate.mockImplementationOnce(async () => gate.promise);
    const startup = lifecycle.ensureReady("a");
    const competingStop = startup.then(() => lifecycle.stop("a"));
    const rejection = expect(competingStop).rejects.toMatchObject({ code: "conflict" });
    const restart = lifecycle.restart("a");
    void restart.catch(() => undefined);
    gate.resolve();
    await rejection;
    await restart;
    expect(host.release).toHaveBeenCalledTimes(1);
    expect(host.activate).toHaveBeenCalledTimes(2);
  });

  it("invalidates history-only resources even when no runtime is loaded", async () => {
    const { lifecycle, host } = fixture();
    await lifecycle.restart("a");
    expect(host.release).toHaveBeenCalledWith("a");
    expect(host.activate).toHaveBeenCalledTimes(1);
  });

  it("keeps lifecycle versions monotonic across stop and reopen", async () => {
    const { lifecycle } = fixture();
    await lifecycle.ensureReady("a");
    const first = await lifecycle.getState("a");
    await lifecycle.stop("a");
    const stopped = await lifecycle.getState("a");
    await lifecycle.ensureReady("a");
    const reopened = await lifecycle.getState("a");
    expect(stopped.revision).toBeGreaterThan(first.revision);
    expect(reopened.revision).toBeGreaterThan(stopped.revision);
    expect(reopened.generation).toBeGreaterThan(first.generation);
  });

  it("keeps a rejected preflight ready and preserves its instance", async () => {
    const { lifecycle, host } = fixture();
    await lifecycle.ensureReady("a");
    host.assertCanStop.mockImplementation(() => {
      throw new Error("busy");
    });
    await expect(lifecycle.stop("a")).rejects.toThrow("busy");
    expect((await lifecycle.getState("a")).state).toBe("ready");
    expect(host.release).not.toHaveBeenCalled();
  });

  it("cleans partial startup and allows an explicit retry", async () => {
    const { lifecycle, host, runtimes } = fixture();
    host.activate.mockImplementationOnce(async (id) => {
      runtimes.add(id);
      throw new Error("init failed");
    });
    await expect(lifecycle.ensureReady("a")).rejects.toThrow("init failed");
    expect(await lifecycle.getState("a")).toMatchObject({
      state: "unloaded",
      lastError: { operation: "ensureReady" },
    });
    expect(host.release).toHaveBeenCalledTimes(1);
    await lifecycle.ensureReady("a");
    expect(await lifecycle.getState("a")).toMatchObject({ state: "ready", lastError: null });
  });

  it("quarantines failed release and never restarts or replays cleanup", async () => {
    const { lifecycle, host, runtimes } = fixture();
    await lifecycle.ensureReady("a");
    host.release.mockImplementation(async (id) => {
      runtimes.delete(id);
      throw new Error("resource timeout");
    });
    const stopping = lifecycle.stop("a");
    const waiting = lifecycle.ensureReady("a");
    await expect(stopping).rejects.toThrow("resource timeout");
    await expect(waiting).rejects.toThrow("resource timeout");
    expect((await lifecycle.getState("a")).state).toBe("faulted");
    for (const action of ["ensureReady", "stop", "restart"] as const) {
      await expect(lifecycle[action]("a")).rejects.toMatchObject({ code: "recoveryRequired" });
    }
    expect(host.activate).toHaveBeenCalledTimes(1);
    expect(host.release).toHaveBeenCalledTimes(1);
  });

  it("quarantines initialization cleanup failure with both errors retained", async () => {
    const { lifecycle, host } = fixture();
    host.activate.mockRejectedValue(new Error("init failed"));
    host.release.mockRejectedValue(new Error("cleanup failed"));
    await expect(lifecycle.ensureReady("a")).rejects.toBeInstanceOf(AggregateError);
    expect((await lifecycle.getState("a")).state).toBe("faulted");
  });
});
