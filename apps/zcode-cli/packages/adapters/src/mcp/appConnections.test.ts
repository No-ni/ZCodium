import type { McpPort, McpServerConfig } from "@zcode/contracts";
import { describe, expect, it, vi } from "vitest";
import { createMcpConnectionPool } from "./pool.js";

describe("MCP App pooled connection lifetime", () => {
  it.each(["lease", "pool"])(
    "%s close rejects new connections from an existing lease",
    async (scope) => {
      const adapter = {
        connectServer: vi.fn(async () => ({ status: "connected" })),
        close: vi.fn(async () => {}),
      };
      const pool = createMcpConnectionPool({ createAdapter: () => adapter as unknown as McpPort });
      const lease = pool.acquireLease();
      try {
        await (scope === "lease" ? lease.close() : pool.close());
        await expect(
          lease.connectServer("fixture", { type: "stdio", command: "fixture" }),
        ).rejects.toThrow("closed");
        expect(adapter.connectServer).not.toHaveBeenCalled();
      } finally {
        await lease.close();
        await pool.close();
      }
    },
  );

  it("closing during revalidation releases the new owner and prevents a late reconnect", async () => {
    const ping = Promise.withResolvers<boolean>();
    const adapter = {
      connectServer: vi.fn(async () => ({ status: "connected" })),
      status: async () => ({ fixture: { status: "connected" } }),
      pingServer: vi.fn(() => ping.promise),
      close: vi.fn(async () => {}),
    };
    const pool = createMcpConnectionPool({ createAdapter: () => adapter as unknown as McpPort });
    const a = pool.acquireLease();
    const b = pool.acquireLease();
    const config: McpServerConfig = {
      type: "stdio",
      command: "fixture",
      isolation: "workspace",
      cwd: "/fixture/session",
    };
    try {
      await a.connectServer("fixture", config, { workingDirectory: "/fixture" });
      const connecting = b.connectServer("fixture", config, {
        workingDirectory: "/fixture",
        revalidate: true,
      });
      const result = connecting.then(
        () => undefined,
        (error: unknown) => error,
      );
      await vi.waitFor(() => expect(adapter.pingServer).toHaveBeenCalledOnce());
      await b.close();
      await a.close();
      expect(adapter.close).toHaveBeenCalledOnce();
      ping.resolve(false);
      expect(await result).toBeInstanceOf(Error);
      expect(adapter.connectServer).toHaveBeenCalledOnce();
    } finally {
      ping.resolve(false);
      await a.close();
      await b.close();
      await pool.close();
    }
  });

  it.each(["disconnect", "remove", "replace"])(
    "%s waits for the retired session connection and lease close joins it",
    async (operation) => {
      const gate = Promise.withResolvers<void>();
      const oldAdapter = {
        connectServer: async () => ({ status: "connected" }),
        status: async () => ({ fixture: { status: "connected" } }),
        close: vi.fn(() => gate.promise),
      };
      const newAdapter = {
        connectServer: async () => ({ status: "connected" }),
        close: vi.fn(async () => {}),
      };
      const createAdapter = vi.fn().mockReturnValueOnce(oldAdapter).mockReturnValue(newAdapter);
      const pool = createMcpConnectionPool({ createAdapter });
      const lease = pool.acquireLease();
      await lease.connectServer("fixture", { type: "stdio", command: "old" });
      let operationDone = false;
      const operationPromise = (
        operation === "disconnect"
          ? lease.disconnectServer("fixture")
          : operation === "remove"
            ? lease.connectConfiguredServers({})
            : lease.connectServer("fixture", { type: "stdio", command: "new" })
      ).then(
        () => {
          operationDone = true;
        },
        (error: unknown) => {
          // lease.close 可拒绝已被关闭租约的迟到连接结果，但必须先完成资源回收。
          operationDone = true;
          return error;
        },
      );
      try {
        for (let turn = 0; turn < 10; turn++) await Promise.resolve();
        expect(oldAdapter.close).toHaveBeenCalledOnce();
        expect(operationDone).toBe(false);
        let leaseDone = false;
        const closing = lease.close().then(() => {
          leaseDone = true;
        });
        for (let turn = 0; turn < 10; turn++) await Promise.resolve();
        expect(leaseDone).toBe(false);
        gate.resolve();
        const [result] = await Promise.all([operationPromise, closing]);
        if (operation === "disconnect") expect(result).toBeUndefined();
        else expect(result).toBeInstanceOf(Error);
        expect(leaseDone).toBe(true);
        expect(oldAdapter.close).toHaveBeenCalledOnce();
      } finally {
        gate.resolve();
        await operationPromise;
        await lease.close();
        await pool.close();
      }
    },
  );

  it.each(["lease", "pool"])("%s close rejects an empty configuration request", async (scope) => {
    const pool = createMcpConnectionPool({ createAdapter: vi.fn() });
    const lease = pool.acquireLease();
    try {
      await (scope === "lease" ? lease.close() : pool.close());
      await expect(lease.connectConfiguredServers({})).rejects.toThrow("closed");
    } finally {
      await lease.close();
      await pool.close();
    }
  });

  it("a delayed disconnect status cannot release the replacement connection", async () => {
    const status = Promise.withResolvers<Record<string, unknown>>();
    const oldAdapter = {
      connectServer: async () => ({ status: "connected" }),
      status: () => status.promise,
      close: vi.fn(async () => {}),
    };
    const snapshot = { identity: "replacement", generation: 2 };
    const replacement = {
      connectServer: async () => ({ status: "connected" }),
      close: vi.fn(async () => {}),
      appConnectionSnapshot: () => snapshot,
    };
    const pool = createMcpConnectionPool({
      createAdapter: vi.fn().mockReturnValueOnce(oldAdapter).mockReturnValue(replacement),
    });
    const lease = pool.acquireLease();
    await lease.connectServer("fixture", { type: "stdio", command: "old" });
    const disconnecting = lease.disconnectServer("fixture");
    try {
      await lease.connectServer("fixture", { type: "stdio", command: "new" });
      status.resolve({ fixture: { status: "connected" } });
      await disconnecting;
      expect(lease.appConnectionSnapshot?.("fixture")).toEqual(snapshot);
      expect(replacement.close).not.toHaveBeenCalled();
    } finally {
      status.resolve({});
      await disconnecting;
      await lease.close();
      await pool.close();
    }
  });

  it("pool shutdown and a following lease shutdown both wait for the same child", async () => {
    const gate = Promise.withResolvers<void>();
    const adapter = {
      connectServer: async () => ({ status: "connected" }),
      close: vi.fn(() => gate.promise),
    };
    const pool = createMcpConnectionPool({ createAdapter: () => adapter as unknown as McpPort });
    const lease = pool.acquireLease();
    await lease.connectServer("fixture", { type: "stdio", command: "fixture" });
    const poolClosing = pool.close();
    let leaseDone = false;
    const leaseClosing = lease.close().then(() => {
      leaseDone = true;
    });
    try {
      for (let turn = 0; turn < 10; turn++) await Promise.resolve();
      expect(leaseDone).toBe(false);
      expect(adapter.close).toHaveBeenCalledOnce();
    } finally {
      gate.resolve();
      await Promise.all([poolClosing, leaseClosing]);
    }
  });

  it("revalidation keeps a live shared owner when the other owner closes", async () => {
    const ping = Promise.withResolvers<boolean>();
    const adapter = {
      connectServer: vi.fn(async () => ({ status: "connected" })),
      status: async () => ({ fixture: { status: "connected" } }),
      pingServer: vi.fn(() => ping.promise),
      close: vi.fn(async () => {}),
    };
    const pool = createMcpConnectionPool({ createAdapter: () => adapter as unknown as McpPort });
    const a = pool.acquireLease(),
      b = pool.acquireLease();
    const config: McpServerConfig = {
      type: "stdio",
      command: "fixture",
      isolation: "workspace",
      cwd: "/fixture/session",
    };
    await a.connectServer("fixture", config, { workingDirectory: "/fixture" });
    const connecting = b.connectServer("fixture", config, {
      workingDirectory: "/fixture",
      revalidate: true,
    });
    try {
      await vi.waitFor(() => expect(adapter.pingServer).toHaveBeenCalledOnce());
      await a.close();
      expect(adapter.close).not.toHaveBeenCalled();
      ping.resolve(false);
      await expect(connecting).resolves.toMatchObject({ status: "connected" });
      expect(adapter.connectServer).toHaveBeenCalledTimes(2);
    } finally {
      ping.resolve(false);
      await connecting.catch(() => undefined);
      await a.close();
      await b.close();
      await pool.close();
    }
  });

  it.each(["session", "execution"])(
    "%s lease close waits for its adapter and pool close joins cleanup",
    async (scope) => {
      const gate = Promise.withResolvers<void>();
      const adapter = {
        connectServer: async () => ({ status: "connected" }),
        close: vi.fn(() => gate.promise),
      };
      const pool = createMcpConnectionPool({ createAdapter: () => adapter as unknown as McpPort });
      const lease = pool.acquireLease({ sessionId: "fixture" });
      await lease.connectServer(
        "fixture",
        {
          type: "stdio",
          command: "fixture",
          ...(scope === "execution" ? { isolation: "workspace", cwd: "/fixture/session" } : {}),
        },
        { workingDirectory: "/fixture" },
      );
      let leaseClosed = false;
      const closing = lease.close().then(() => {
        leaseClosed = true;
      });
      try {
        await Promise.resolve();
        expect(adapter.close).toHaveBeenCalledOnce();
        expect(leaseClosed).toBe(false);
        const repeated = lease.close();
        let poolClosed = false;
        const poolClosing = pool.close().then(() => {
          poolClosed = true;
        });
        let repeatedPoolClosed = false;
        const repeatedPoolClosing = pool.close().then(() => {
          repeatedPoolClosed = true;
        });
        await Promise.resolve();
        expect(poolClosed).toBe(false);
        expect(repeatedPoolClosed).toBe(false);
        gate.resolve();
        await Promise.all([closing, repeated, poolClosing, repeatedPoolClosing]);
        expect(adapter.close).toHaveBeenCalledOnce();
        expect(leaseClosed).toBe(true);
        expect(poolClosed).toBe(true);
      } finally {
        gate.resolve();
        await pool.close();
      }
    },
  );

  it("workspace isolation keeps its idle grace after the final owner leaves", async () => {
    vi.useFakeTimers();
    const adapter = {
      connectServer: async () => ({ status: "connected" }),
      close: vi.fn(async () => {}),
    };
    const pool = createMcpConnectionPool({
      createAdapter: () => adapter as unknown as McpPort,
      idleGraceMs: 100,
    });
    const a = pool.acquireLease({ sessionId: "a" });
    const b = pool.acquireLease({ sessionId: "b" });
    try {
      const config: McpServerConfig = { type: "stdio", command: "fixture", isolation: "workspace" };
      await a.connectServer("fixture", config, { workingDirectory: "/fixture" });
      await b.connectServer("fixture", config, { workingDirectory: "/fixture" });
      await a.close();
      expect(adapter.close).not.toHaveBeenCalled();
      await b.close();
      expect(adapter.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(100);
      expect(adapter.close).toHaveBeenCalledOnce();
    } finally {
      await pool.close();
      vi.useRealTimers();
    }
  });

  it("forwards the trusted snapshot and invalidates one lease without closing another owner", async () => {
    const listeners = new Set<() => void>();
    const snapshot = { identity: "trusted", generation: 7 };
    const adapter = {
      connectServer: async () => ({ status: "connected" }),
      listTools: async () => [],
      status: async () => ({ fixture: { status: "connected" } }),
      close: vi.fn(async () => {}),
      appConnectionSnapshot: () => snapshot,
      onAppConnectionInvalidated: (_name: string, listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      callTool: vi.fn(async () => {
        throw new Error("Not connected");
      }),
    };
    const createAdapter = vi.fn(() => adapter as unknown as McpPort);
    const pool = createMcpConnectionPool({ createAdapter, idleGraceMs: 0 });
    const a = pool.acquireLease({ sessionId: "a" }),
      b = pool.acquireLease({ sessionId: "b" });
    const config: McpServerConfig = { type: "stdio", command: "fixture", isolation: "workspace" };
    await a.connectServer("fixture", config, { workingDirectory: "/fixture" });
    await b.connectServer("fixture", config, { workingDirectory: "/fixture" });
    expect(createAdapter).toHaveBeenCalledOnce();
    expect(a.appConnectionSnapshot?.("fixture")).toEqual(snapshot);
    const revokeA = vi.fn(),
      revokeB = vi.fn();
    a.onAppConnectionInvalidated?.("fixture", revokeA);
    b.onAppConnectionInvalidated?.("fixture", revokeB);
    await expect(
      b.callTool({ serverName: "fixture", toolName: "increment" }, { appConnection: snapshot }),
    ).rejects.toThrow("Not connected");
    expect(adapter.callTool).toHaveBeenCalledTimes(1);
    await a.close();
    expect(revokeA).toHaveBeenCalledOnce();
    expect(revokeB).not.toHaveBeenCalled();
    expect(a.appConnectionSnapshot?.("fixture")).toBeNull();
    expect(b.appConnectionSnapshot?.("fixture")).toEqual(snapshot);
    expect(listeners.size).toBe(1);
    expect(adapter.close).not.toHaveBeenCalled();
    await b.close();
    expect(revokeB).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(0);
    await pool.close();
  });
});
