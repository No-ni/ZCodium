import { describe, expect, it, vi } from "vitest";
import { createWindowRemoteConnectionRegistry } from "./windowRemoteConnectionRegistry.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const parameters = {
  requestId: "request-1",
  target: { kind: "docker" as const, container: "fixture" },
  remoteAssets: {},
  workspacePath: "/fixture",
  workspaceIdentity: "fixture-identity",
};

function createHandle() {
  return { services: { marker: "fixture" }, dispose: vi.fn(async () => {}) };
}

describe("window remote connection retirement", () => {
  it("closes an online handle once across repeated registry disposal", async () => {
    const handle = createHandle();
    const registry = createWindowRemoteConnectionRegistry({
      connect: async () => handle,
      createId: () => "remote-1",
    });
    await registry.connect(parameters);
    await Promise.all([registry.dispose(), registry.dispose()]);
    expect(handle.dispose).toHaveBeenCalledTimes(1);
  });

  for (const action of ["registry", "session"] as const) {
    it(`closes a late handle after ${action} disposal`, async () => {
      const handle = createHandle();
      const pending = deferred<typeof handle>();
      const registry = createWindowRemoteConnectionRegistry({
        connect: () => pending.promise,
        createId: () => "remote-1",
      });
      const connecting = registry.connect(parameters);
      const rejected = expect(connecting).rejects.toThrow(/取消/);
      if (action === "registry") await registry.dispose();
      else await registry.disposeSession("remote-1");
      pending.resolve(handle);
      await rejected;
      await registry.dispose();
      expect(handle.dispose).toHaveBeenCalledTimes(1);
      expect(registry.getStats()).toEqual({ connectionCount: 0, logicalSessionCount: 0 });
    });
  }

  it("retires a cancelled SSH handle without affecting a new connection for the same key", async () => {
    const oldHandle = createHandle();
    const newHandle = createHandle();
    const pending = deferred<typeof oldHandle>();
    let ids = 0;
    const registry = createWindowRemoteConnectionRegistry({
      connect: vi
        .fn()
        .mockImplementationOnce(() => pending.promise)
        .mockResolvedValue(newHandle),
      createId: () => `remote-${++ids}`,
    });
    const target = { kind: "ssh" as const, host: "fixture.invalid", username: "fixture" };
    const connecting = registry.connect({ ...parameters, target });
    const rejected = expect(connecting).rejects.toThrow(/取消/);
    registry.cancelConnect(parameters.requestId);
    const descriptor = await registry.connect({ ...parameters, target, requestId: "request-2" });
    pending.resolve(oldHandle);
    await rejected;
    await Promise.resolve();
    expect(oldHandle.dispose).toHaveBeenCalledTimes(1);
    expect(newHandle.dispose).not.toHaveBeenCalled();
    expect(
      registry.resolveScopedServices({
        kind: "remote",
        remoteSessionId: descriptor.remoteSessionId,
        workspacePath: parameters.workspacePath,
        workspaceIdentity: parameters.workspaceIdentity,
      }),
    ).toBe(newHandle.services);
    await registry.dispose();
    expect(newHandle.dispose).toHaveBeenCalledTimes(1);
  });

  for (const synchronous of [true, false]) {
    it(`does not repeat a ${synchronous ? "synchronous" : "asynchronous"} failing disposal`, async () => {
      const failure = new Error("fixture dispose failure");
      const handle = {
        services: {},
        dispose: vi.fn(() => {
          if (synchronous) throw failure;
          return Promise.reject(failure);
        }),
      };
      const registry = createWindowRemoteConnectionRegistry({
        connect: async () => handle,
        createId: () => "remote-1",
      });
      await registry.connect(parameters);
      await expect(registry.disposeSession("remote-1")).rejects.toThrow(failure);
      await registry.dispose();
      expect(handle.dispose).toHaveBeenCalledTimes(1);
    });
  }
});
