import { describe, expect, it, vi } from "vitest";
import { WorkspaceBridgeLifecycle } from "./workspaceBridgeLifecycle.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function flush() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe("WorkspaceBridgeLifecycle", () => {
  it("A ready → B deferred → A 必须串行重开 A，迟到 B 不接管", async () => {
    const b = deferred();
    const a2 = deferred();
    const invalidate = vi.fn();
    const open = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(b.promise)
      .mockReturnValueOnce(a2.promise);
    const bridge = new WorkspaceBridgeLifecycle(invalidate, open);
    await bridge.ensure({ workspaceKey: "A" });
    expect(bridge.isReady({ workspaceKey: "A" })).toBe(true);
    const firstVersion = bridge.version;
    const pendingB = bridge.ensure({ workspaceKey: "B" }).catch((error: Error) => error.message);
    expect(bridge.isReady({ workspaceKey: "A" })).toBe(false);
    expect(bridge.isCurrent(firstVersion)).toBe(false);
    await flush();
    expect(open).toHaveBeenCalledTimes(2);
    const pendingA = bridge.ensure({ workspaceKey: "A" });
    await flush();
    expect(open).toHaveBeenCalledTimes(2);
    b.resolve();
    await flush();
    expect(await pendingB).toBe("workspace bridge superseded");
    expect(bridge.isReady({ workspaceKey: "B" })).toBe(false);
    expect(open).toHaveBeenCalledTimes(3);
    expect(open.mock.calls.map(([target]) => target.workspaceKey)).toEqual(["A", "B", "A"]);
    a2.resolve();
    await pendingA;
    expect(bridge.isReady({ workspaceKey: "A" })).toBe(true);
    expect(invalidate).toHaveBeenCalledTimes(3);
  });

  it("同目标去重，过时排队 open 不发送", async () => {
    const first = deferred();
    const open = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
    const bridge = new WorkspaceBridgeLifecycle(vi.fn(), open);
    const a = bridge.ensure({ workspaceKey: "A", remoteSessionId: "session-A" }).catch(() => {});
    await flush();
    const b = bridge.ensure({ workspaceKey: "B", remoteSessionId: "session-B" }).catch(() => {});
    const cTarget = { workspaceKey: "C", remoteSessionId: "session-C" };
    const c = bridge.ensure(cTarget);
    expect(bridge.ensure(cTarget)).toBe(c);
    first.resolve();
    await Promise.all([a, b, c]);
    expect(open.mock.calls.map(([target]) => target.workspaceKey)).toEqual(["A", "C"]);
    await bridge.ensure(cTarget);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("同一 workspace key 的 remoteSessionId 换代时重开", async () => {
    const open = vi.fn().mockResolvedValue(undefined);
    const bridge = new WorkspaceBridgeLifecycle(vi.fn(), open);
    await bridge.ensure({ workspaceKey: "remote-workspace", remoteSessionId: "remote-A" });
    await bridge.ensure({ workspaceKey: "remote-workspace", remoteSessionId: "remote-B" });
    expect(open).toHaveBeenCalledTimes(2);
    expect(open.mock.calls.map(([target]) => target.remoteSessionId)).toEqual([
      "remote-A",
      "remote-B",
    ]);
  });

  it("握手失败释放半就绪世代，下次 ensure 可重试", async () => {
    const invalidate = vi.fn();
    const open = vi
      .fn()
      .mockRejectedValueOnce(new Error("open rejected"))
      .mockResolvedValue(undefined);
    const bridge = new WorkspaceBridgeLifecycle(invalidate, open);
    const first = bridge.ensure({ workspaceKey: "A" });
    const generation = bridge.version;
    await expect(first).rejects.toThrow("open rejected");
    expect(bridge.isReady({ workspaceKey: "A" })).toBe(false);
    expect(bridge.isCurrent(generation)).toBe(false);
    expect(invalidate).toHaveBeenCalledTimes(2);
    await bridge.ensure({ workspaceKey: "A" });
    expect(bridge.isReady({ workspaceKey: "A" })).toBe(true);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("降级清 ready 后同 workspace 也重新 open", async () => {
    const open = vi.fn().mockResolvedValue(undefined);
    const bridge = new WorkspaceBridgeLifecycle(vi.fn(), open);
    await bridge.ensure({ workspaceKey: "A" });
    bridge.invalidate();
    expect(bridge.isReady({ workspaceKey: "A" })).toBe(false);
    await bridge.ensure({ workspaceKey: "A" });
    expect(open).toHaveBeenCalledTimes(2);
  });
});
