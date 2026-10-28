import type {
  McpConnectOptions,
  McpPort,
  McpServerConfig,
  McpServerStatus,
} from "@zcode/contracts";
import { describe, expect, it, vi } from "vitest";
import { createMcpConnectionPool } from "./pool.js";

const WORKSPACE_A = "C:/fixture/a";
const WORKSPACE_B = "C:/fixture/b";
const CONFIG: McpServerConfig = { type: "stdio", command: "fixture" };
const STATUS: McpServerStatus = {
  status: "connected",
  transport: "stdio",
  toolCount: 0,
  updatedAt: "fixture",
};
const FLUSH_TURNS = 20;
const IDLE_GRACE_MS = 60_000;
async function flush() {
  for (let turn = 0; turn < FLUSH_TURNS; turn++) await Promise.resolve();
}
function adapter() {
  return {
    connectServer: vi.fn(async () => STATUS),
    status: vi.fn(async (): Promise<Record<string, McpServerStatus>> => ({ fixture: STATUS })),
    listTools: vi.fn(async () => []),
    pingServer: vi.fn(async () => true),
    close: vi.fn(async () => {}),
    connectConfiguredServers: vi.fn(async () => ({ statuses: {}, tools: [] })),
    disconnectServer: vi.fn(async () => undefined),
    callTool: vi.fn(async () => ({ content: [] })),
  };
}
function capture<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  );
}

describe("MCP lease configuration admission", () => {
  it("a later empty configuration removes an admitted pending connection", async () => {
    const connecting = Promise.withResolvers<McpServerStatus>();
    const port = adapter();
    port.connectServer.mockImplementation(() => connecting.promise);
    const pool = createMcpConnectionPool({ createAdapter: () => port as McpPort });
    const lease = pool.acquireLease();
    const older = capture(lease.connectConfiguredServers({ fixture: CONFIG }));
    try {
      const newer = await lease.connectConfiguredServers({});
      expect(newer).toEqual({ statuses: {}, tools: [] });
      connecting.resolve(STATUS);
      expect((await older).error).toBeInstanceOf(Error);
      expect(pool.stats().activeConnections).toBe(0);
    } finally {
      connecting.resolve(STATUS);
      await older;
      await lease.close();
      await pool.close();
    }
  });

  it("a configuration waiting for removed resources cannot overwrite a later one", async () => {
    const closed = Promise.withResolvers<void>();
    const first = adapter();
    first.close.mockImplementation(() => closed.promise);
    const createAdapter = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockImplementation(() => adapter());
    const pool = createMcpConnectionPool({ createAdapter });
    const lease = pool.acquireLease();
    await lease.connectServer("fixture", CONFIG);
    const older = capture(
      lease.connectConfiguredServers({ fixture: { ...CONFIG, command: "middle" } }),
    );
    try {
      await flush();
      const latestConfig = { ...CONFIG, command: "latest" };
      const newer = capture(lease.connectConfiguredServers({ fixture: latestConfig }));
      closed.resolve();
      expect((await newer).error).toBeUndefined();
      expect((await older).error).toBeInstanceOf(Error);
      expect(createAdapter.mock.calls.at(-1)?.[0].config.command).toBe("latest");
    } finally {
      closed.resolve();
      await older;
      await lease.close();
      await pool.close();
    }
  });

  it("rejects an old snapshot when its status read outlives configuration replacement", async () => {
    const status = Promise.withResolvers<Record<string, McpServerStatus>>();
    const first = adapter();
    first.status.mockImplementation(() => status.promise);
    const replacement = adapter();
    const pool = createMcpConnectionPool({
      createAdapter: vi.fn().mockReturnValueOnce(first).mockReturnValue(replacement),
    });
    const lease = pool.acquireLease();
    const older = capture(lease.connectConfiguredServers({ fixture: CONFIG }));
    try {
      await vi.waitFor(() => expect(first.status).toHaveBeenCalled());
      await lease.connectConfiguredServers({ fixture: { ...CONFIG, command: "replacement" } });
      status.resolve({ fixture: STATUS });
      expect((await older).error).toBeInstanceOf(Error);
      expect(first.listTools).not.toHaveBeenCalled();
    } finally {
      status.resolve({ fixture: STATUS });
      await older;
      await lease.close();
      await pool.close();
    }
  });

  it.each(["disconnect", "replace", "close"] as const)(
    "reentrant lease close during %s waits for resources and leaves no active refs",
    async (operation) => {
      const closed = Promise.withResolvers<void>();
      const first = adapter(),
        second = adapter();
      first.close.mockImplementation(() => closed.promise);
      const pool = createMcpConnectionPool({
        createAdapter: vi.fn().mockReturnValueOnce(first).mockReturnValue(second),
      });
      const lease = pool.acquireLease();
      await lease.connectServer("fixture", CONFIG);
      let nested: Promise<void> | undefined;
      let nestedDone = false;
      lease.onAppConnectionInvalidated?.("fixture", () => {
        nested = lease.close().then(() => {
          nestedDone = true;
        });
      });
      const result = capture<unknown>(
        operation === "disconnect"
          ? lease.disconnectServer("fixture")
          : operation === "replace"
            ? lease.connectServer("fixture", { ...CONFIG, command: "replacement" })
            : lease.close(),
      );
      try {
        await flush();
        expect(first.close).toHaveBeenCalledOnce();
        expect(nestedDone).toBe(false);
        expect(second.connectServer).not.toHaveBeenCalled();
        closed.resolve();
        await result;
        await nested;
        await lease.close();
        expect(first.close).toHaveBeenCalledOnce();
        expect(pool.stats().activeConnections).toBe(0);
      } finally {
        closed.resolve();
        await result;
        await nested;
        await lease.close();
        await pool.close();
      }
    },
  );

  it.each(["root", "execution"] as const)(
    "reentrant lease close preserves another workspace %s owner and its final grace",
    async (scope) => {
      const port = adapter();
      const pool = createMcpConnectionPool({
        createAdapter: () => port as McpPort,
        idleGraceMs: IDLE_GRACE_MS,
      });
      const a = pool.acquireLease(),
        b = pool.acquireLease();
      const config: McpServerConfig = {
        ...CONFIG,
        isolation: "workspace",
        ...(scope === "execution" ? { cwd: "session" } : {}),
      };
      const options = { workingDirectory: WORKSPACE_A };
      let nested: Promise<void> | undefined;
      try {
        await a.connectServer("fixture", config, options);
        await b.connectServer("fixture", config, options);
        a.onAppConnectionInvalidated?.("fixture", () => {
          nested = a.close();
        });
        await a.disconnectServer("fixture");
        await nested;
        expect(port.close).not.toHaveBeenCalled();
        expect(pool.stats().activeConnections).toBe(1);
        await expect(b.callTool({ serverName: "fixture", toolName: "fixture" })).resolves.toEqual({
          content: [],
        });
        await b.close();
        if (scope === "root") {
          expect(port.close).not.toHaveBeenCalled();
          expect(pool.stats().pendingCloseConnections).toBe(1);
        } else {
          expect(port.close).toHaveBeenCalledOnce();
          expect(pool.stats().activeConnections).toBe(0);
        }
      } finally {
        await a.close();
        await b.close();
        await pool.close();
      }
    },
  );

  it("keeps concurrent single-server admissions for different names", async () => {
    const connecting = Promise.withResolvers<McpServerStatus>();
    const first = adapter();
    first.connectServer.mockImplementation(() => connecting.promise);
    const pool = createMcpConnectionPool({
      createAdapter: vi.fn().mockReturnValueOnce(first).mockReturnValue(adapter()),
    });
    const lease = pool.acquireLease();
    const a = lease.connectServer("a", CONFIG);
    const b = lease.connectServer("b", CONFIG);
    try {
      await expect(b).resolves.toEqual(STATUS);
      connecting.resolve(STATUS);
      await expect(a).resolves.toEqual(STATUS);
      expect(pool.stats().activeConnections).toBe(2);
    } finally {
      connecting.resolve(STATUS);
      await Promise.allSettled([a, b]);
      await lease.close();
      await pool.close();
    }
  });
});

describe("MCP connection cache boundaries", () => {
  const contexts: [string, McpConnectOptions, McpConnectOptions][] = [
    ["local cwd fallback", { workingDirectory: WORKSPACE_A }, { workingDirectory: WORKSPACE_B }],
    [
      "workspace identity",
      { workingDirectory: WORKSPACE_A, workspaceIdentity: "identity-a" },
      { workingDirectory: WORKSPACE_A, workspaceIdentity: "identity-b" },
    ],
    [
      "execution cwd under one identity",
      { workingDirectory: WORKSPACE_A, workspaceIdentity: "identity" },
      { workingDirectory: WORKSPACE_B, workspaceIdentity: "identity" },
    ],
  ];
  it.each(contexts)("same settings lease isolates %s", async (_name, a, b) => {
    const first = adapter();
    const second = adapter();
    const createAdapter = vi.fn().mockReturnValueOnce(first).mockReturnValue(second);
    const pool = createMcpConnectionPool({ createAdapter });
    const lease = pool.acquireLease({ leaseId: "protocol-settings" });
    try {
      await lease.connectConfiguredServers({ fixture: CONFIG }, { ...a, revalidate: true });
      await lease.connectConfiguredServers({ fixture: CONFIG }, { ...b, revalidate: true });
      expect(createAdapter).toHaveBeenCalledTimes(2);
      expect(createAdapter.mock.calls[1]?.[0].workingDirectory).toBe(b.workingDirectory);
      expect(first.close).toHaveBeenCalledOnce();
    } finally {
      await lease.close();
      await pool.close();
    }
  });

  it("workspace isolation still shares across leases with the same identity and cwd", async () => {
    const createAdapter = vi.fn(() => adapter());
    const pool = createMcpConnectionPool({ createAdapter });
    const a = pool.acquireLease();
    const b = pool.acquireLease();
    const config = { ...CONFIG, isolation: "workspace" as const };
    const options = { workingDirectory: WORKSPACE_A, workspaceIdentity: "identity" };
    try {
      await a.connectServer("fixture", config, options);
      await b.connectServer("fixture", config, options);
      expect(createAdapter).toHaveBeenCalledOnce();
    } finally {
      await a.close();
      await b.close();
      await pool.close();
    }
  });

  it("workspace isolation does not share different execution cwd under one identity", async () => {
    const createAdapter = vi.fn(() => adapter());
    const pool = createMcpConnectionPool({ createAdapter });
    const a = pool.acquireLease();
    const b = pool.acquireLease();
    const config = { ...CONFIG, isolation: "workspace" as const };
    try {
      await a.connectServer("fixture", config, {
        workingDirectory: WORKSPACE_A,
        workspaceIdentity: "identity",
      });
      await b.connectServer("fixture", config, {
        workingDirectory: WORKSPACE_B,
        workspaceIdentity: "identity",
      });
      expect(createAdapter).toHaveBeenCalledTimes(2);
    } finally {
      await a.close();
      await b.close();
      await pool.close();
    }
  });
});

describe("MCP failed admission cleanup", () => {
  it.each(["synchronous throw", "asynchronous rejection"])(
    "%s waits for the same adapter close as pool and lease shutdown",
    async (kind) => {
      const closed = Promise.withResolvers<void>();
      const failure = new Error("fixture connect failure");
      const port = adapter();
      port.close.mockImplementation(() => closed.promise);
      port.connectServer.mockImplementation(() => {
        if (kind === "synchronous throw") throw failure;
        return Promise.reject(failure);
      });
      const pool = createMcpConnectionPool({ createAdapter: () => port as McpPort });
      const lease = pool.acquireLease();
      let done = false;
      const result = capture(lease.connectServer("fixture", CONFIG)).then((value) => {
        done = true;
        return value;
      });
      try {
        await flush();
        expect(port.close).toHaveBeenCalledOnce();
        expect(done).toBe(false);
        let shutdownDone = false;
        const shutdown = Promise.all([
          pool.close(),
          pool.close(),
          lease.close(),
          lease.close(),
        ]).then(() => {
          shutdownDone = true;
        });
        await flush();
        expect(shutdownDone).toBe(false);
        closed.resolve();
        expect((await result).error).toBe(failure);
        await shutdown;
        expect(port.close).toHaveBeenCalledOnce();
      } finally {
        closed.resolve();
        await result;
        await lease.close();
        await pool.close();
      }
    },
  );

  it("a failed shared entry cannot lend a same-key replacement to its old lease", async () => {
    const failed = adapter();
    failed.connectServer.mockRejectedValue(new Error("fixture failure"));
    const replacement = adapter();
    const snapshot = { identity: "replacement", generation: 1 };
    const createAdapter = vi
      .fn()
      .mockReturnValueOnce(failed)
      .mockReturnValue({
        ...replacement,
        appConnectionSnapshot: () => snapshot,
      });
    const pool = createMcpConnectionPool({ createAdapter });
    const a = pool.acquireLease();
    const b = pool.acquireLease();
    const config = { ...CONFIG, isolation: "workspace" as const };
    const options = { workingDirectory: WORKSPACE_A };
    try {
      await expect(a.connectServer("fixture", config, options)).rejects.toThrow("fixture failure");
      await expect(b.connectServer("fixture", config, options)).resolves.toEqual(STATUS);
      expect(a.appConnectionSnapshot?.("fixture")).toBeNull();
      await a.close();
      expect(b.appConnectionSnapshot?.("fixture")).toEqual(snapshot);
      expect(replacement.close).not.toHaveBeenCalled();
    } finally {
      await a.close();
      await b.close();
      await pool.close();
    }
  });

  it("a workspace startup rejected at zero refs does not poison the idle grace cache", async () => {
    const first = adapter();
    const second = adapter();
    const createAdapter = vi.fn().mockReturnValueOnce(first).mockReturnValue(second);
    const pool = createMcpConnectionPool({ createAdapter, idleGraceMs: IDLE_GRACE_MS });
    const a = pool.acquireLease();
    const b = pool.acquireLease();
    const config = { ...CONFIG, isolation: "workspace" as const };
    const options = { workingDirectory: WORKSPACE_A };
    const pending = capture(a.connectServer("fixture", config, options));
    try {
      await a.close();
      expect((await pending).error).toBeInstanceOf(Error);
      expect(first.connectServer).not.toHaveBeenCalled();
      expect(first.close).toHaveBeenCalledOnce();
      expect(pool.stats().activeConnections).toBe(0);
      await expect(b.connectServer("fixture", config, options)).resolves.toEqual(STATUS);
      expect(createAdapter).toHaveBeenCalledTimes(2);
      expect(second.connectServer).toHaveBeenCalledOnce();
      await b.close();
      expect(second.close).not.toHaveBeenCalled();
      expect(pool.stats().pendingCloseConnections).toBe(1);
    } finally {
      await pending;
      await a.close();
      await b.close();
      await pool.close();
    }
  });

  it.each(["lease", "pool"])("%s close before adapter startup prevents launch", async (scope) => {
    const port = adapter();
    const pool = createMcpConnectionPool({ createAdapter: () => port as McpPort });
    const lease = pool.acquireLease();
    const result = capture(lease.connectServer("fixture", CONFIG));
    try {
      await (scope === "lease" ? lease.close() : pool.close());
      expect((await result).error).toBeInstanceOf(Error);
      expect(port.connectServer).not.toHaveBeenCalled();
      expect(port.close).toHaveBeenCalledOnce();
    } finally {
      await result;
      await lease.close();
      await pool.close();
    }
  });
});
