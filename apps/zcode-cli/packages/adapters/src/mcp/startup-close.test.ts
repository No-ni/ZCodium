import type { McpPort, McpServerConfig } from "@zcode/contracts";
import { Client } from "@modelcontextprotocol/client";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setImmediate as nextTurn } from "node:timers/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpAdapter } from "./index.js";
import { createMcpConnectionPool } from "./pool.js";
import { terminateMcpStdioProcessTree } from "./process-tree.js";
import { ProcessTreeStdioClientTransport } from "./stdio-transport.js";
import { McpTimeoutError, waitWithinMcpDeadline, withTimeout } from "./timeout.js";
import { createInteractiveAuthorizationRequiredError } from "./oauth-errors.js";

const config: McpServerConfig = {
  type: "stdio",
  command: process.execPath,
  args: ["-e", "setInterval(() => {}, 1000)"],
  protocolVersion: "legacy",
  timeoutMs: 1_000,
};
const transports = new Set<ProcessTreeStdioClientTransport>();
const adapters = new Set<McpPort>();
const sdkConnections = new Set<Promise<void>>();
const originalStart = ProcessTreeStdioClientTransport.prototype.start;
const originalConnect = Client.prototype.connect;

afterEach(async () => {
  vi.restoreAllMocks();
  for (const transport of transports) {
    const pid = transport.pid;
    if (pid) await terminateMcpStdioProcessTree(pid);
    await transport.close();
  }
  await Promise.allSettled(sdkConnections);
  await Promise.all([...adapters].map((adapter) => adapter.close()));
  transports.clear();
  sdkConnections.clear();
  adapters.clear();
});

function fixture() {
  const start = vi
    .spyOn(ProcessTreeStdioClientTransport.prototype, "start")
    .mockImplementation(function (this: ProcessTreeStdioClientTransport) {
      transports.add(this);
      return originalStart.call(this);
    });
  vi.spyOn(Client.prototype, "connect").mockImplementation(function (this: Client, ...args) {
    const connecting = originalConnect.apply(this, args);
    sdkConnections.add(connecting);
    // 红测的迟到 SDK 拒绝也必须可观察，不能阻断测试自身对真实 child 的清理。
    void connecting.catch(() => undefined);
    return connecting;
  });
  const adapter = createMcpAdapter({ workingDirectory: tmpdir() });
  adapters.add(adapter);
  return { adapter, start };
}

function observe<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}

describe("MCP adapter startup and close ownership", () => {
  it.each([0, 1, 2, 4])(
    "isolated process closes after %i microtasks without an unhandled SDK rejection",
    async (turns) => {
      const run = promisify(execFile);
      const fixturePath = fileURLToPath(
        new URL("../../test/fixtures/mcp-startup-close.ts", import.meta.url),
      );
      const { stdout } = await run(
        process.execPath,
        ["--import", "tsx", fixturePath, String(turns)],
        {
          windowsHide: true,
        },
      );
      expect(JSON.parse(stdout)).toEqual({
        aliveAfterLeaseClose: false,
        aliveAfterPoolClose: false,
        result: "rejected",
        activeConnections: 0,
      });
    },
    15_000,
  );

  it("close before the first adapter await prevents a late record and process", async () => {
    const { adapter, start } = fixture();
    const connecting = observe(adapter.connectServer("fixture", config));
    await adapter.close();
    expect(await connecting).toHaveProperty("error");
    expect(start).not.toHaveBeenCalled();
    expect(await adapter.status()).toEqual({});
  });

  it("disconnect before the first adapter await invalidates pending admission", async () => {
    const { adapter, start } = fixture();
    const connecting = observe(adapter.connectServer("fixture", { ...config, enabled: false }));
    await adapter.disconnectServer("fixture");
    expect(await connecting).toHaveProperty("error");
    expect(start).not.toHaveBeenCalled();
    expect(await adapter.status()).toEqual({});
  });

  it("concurrent same-name admission cannot publish the older record", async () => {
    const { adapter, start } = fixture();
    const old = observe(adapter.connectServer("fixture", { ...config, enabled: false }));
    const current = observe(adapter.connectServer("fixture", config));
    await adapter.close();
    expect(await old).toHaveProperty("error");
    await current;
    expect(start).not.toHaveBeenCalled();
    expect(await adapter.status()).toEqual({});
  });

  it("a closed adapter rejects server and empty configuration admission", async () => {
    const { adapter, start } = fixture();
    await adapter.close();
    await expect(adapter.connectServer("fixture", { ...config, enabled: false })).rejects.toThrow(
      "closed",
    );
    await expect(adapter.connectConfiguredServers({})).rejects.toThrow("closed");
    expect(start).not.toHaveBeenCalled();
  });

  it("lease and pool close wait for transport creation and forbid a late launch", async () => {
    const { adapter, start } = fixture();
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const internal = adapter as unknown as {
      createTransport(...args: unknown[]): Promise<{ transport: ProcessTreeStdioClientTransport }>;
    };
    const createTransport = internal.createTransport.bind(internal);
    vi.spyOn(internal, "createTransport").mockImplementation(async (...args) => {
      const bundle = await createTransport(...args);
      transports.add(bundle.transport);
      entered.resolve();
      await gate.promise;
      return bundle;
    });
    const pool = createMcpConnectionPool({ createAdapter: () => adapter });
    const lease = pool.acquireLease();
    const connecting = observe(lease.connectServer("fixture", config));
    await entered.promise;
    let leaseDone = false;
    let poolDone = false;
    const leaseClosing = lease.close().then(() => {
      leaseDone = true;
    });
    const poolClosing = pool.close().then(() => {
      poolDone = true;
    });
    try {
      await nextTurn();
      expect(leaseDone).toBe(false);
      expect(poolDone).toBe(false);
      gate.resolve();
      await Promise.all([leaseClosing, poolClosing]);
      expect(await connecting).toHaveProperty("error");
      expect(start).not.toHaveBeenCalled();
      expect(pool.stats().activeConnections).toBe(0);
    } finally {
      gate.resolve();
      await Promise.all([leaseClosing, poolClosing, connecting]);
    }
  });

  it("close drains SDK startup even after the actual child has spawned", async () => {
    const { adapter, start } = fixture();
    const spawned = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    start.mockImplementation(async function (this: ProcessTreeStdioClientTransport) {
      transports.add(this);
      await originalStart.call(this);
      spawned.resolve();
      await gate.promise;
    });
    const sdkDone = Promise.withResolvers<void>();
    vi.spyOn(Client.prototype, "connect").mockImplementation(async function (
      this: Client,
      ...args
    ) {
      try {
        return await originalConnect.apply(this, args);
      } finally {
        await sdkDone.promise;
      }
    });
    const connecting = observe(adapter.connectServer("fixture", config));
    await spawned.promise;
    expect([...transports].some((transport) => transport.processAlive)).toBe(true);
    let closeDone = false;
    const closing = adapter.close().then(() => {
      closeDone = true;
    });
    try {
      await nextTurn();
      expect(closeDone).toBe(false);
      gate.resolve();
      await nextTurn();
      expect(closeDone).toBe(false);
      sdkDone.resolve();
      await Promise.all([closing, connecting]);
      expect([...transports].some((transport) => transport.processAlive)).toBe(false);
      expect(await adapter.status()).toEqual({});
    } finally {
      gate.resolve();
      sdkDone.resolve();
      await Promise.all([closing, connecting]);
    }
  });

  it("an already aborted caller never starts stdio", async () => {
    const { adapter, start } = fixture();
    const signal = AbortSignal.abort(new Error("fixture cancelled"));
    await adapter.connectServer("fixture", config, { signal });
    await adapter.close();
    expect(start).not.toHaveBeenCalled();
    expect([...transports].some((transport) => transport.processAlive)).toBe(false);
  });

  it("a closed adapter cannot be revived by a delayed OAuth tool failure", async () => {
    const { adapter } = fixture();
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const tools = Promise.withResolvers<void>();
    vi.spyOn(Client.prototype, "connect").mockImplementation(async () => undefined);
    vi.spyOn(Client.prototype, "listTools").mockImplementation(async () => ({ tools: [] }));
    const config: McpServerConfig = {
      type: "http",
      url: "https://fixture.example.invalid/mcp",
      headers: { Authorization: "Bearer fixture-token" },
      oauth: { type: "authorization_code" },
      protocolVersion: "legacy",
    };
    await adapter.connectServer("fixture", config);
    const internal = adapter as unknown as {
      callToolOnClient(...args: unknown[]): Promise<never>;
      runInteractiveOAuthAuthorization(
        ...args: unknown[]
      ): Promise<{ status: "failed"; error: Error }>;
    };
    vi.spyOn(internal, "callToolOnClient").mockImplementation(async () => {
      entered.resolve();
      await gate.promise;
      throw createInteractiveAuthorizationRequiredError({
        serverName: "fixture",
        reason: "unauthorized",
      });
    });
    const authorize = vi
      .spyOn(internal, "runInteractiveOAuthAuthorization")
      .mockImplementation(async () => {
        await tools.promise;
        return { status: "failed", error: new Error("fixture auth failure") };
      });
    const calling = observe(adapter.callTool({ serverName: "fixture", toolName: "fixture" }));
    try {
      await entered.promise;
      await adapter.close();
      gate.resolve();
      tools.resolve();
      expect(await calling).toHaveProperty("error");
      expect(authorize).not.toHaveBeenCalled();
      expect(await adapter.status()).toEqual({});
    } finally {
      gate.resolve();
      tools.resolve();
      await calling;
    }
  });

  it("app invalidation can reenter the same adapter close without recursion", async () => {
    const { adapter } = fixture();
    await adapter.connectServer("fixture", { ...config, enabled: false });
    let nested: Promise<void> | undefined;
    adapter.onAppConnectionInvalidated?.("fixture", () => {
      nested = adapter.close();
    });
    await adapter.close();
    await nested;
    expect(await adapter.status()).toEqual({});
  });

  it("an expired deadline still observes the already started operation", async () => {
    const operation = Promise.withResolvers<void>();
    const then = vi.spyOn(operation.promise, "then");
    try {
      const waiting = observe(
        Promise.resolve().then(() =>
          waitWithinMcpDeadline(
            operation.promise,
            { expiresAt: Date.now() - 1, timeoutMs: 1 },
            "fixture expired deadline",
          ),
        ),
      );
      expect(await waiting).toHaveProperty("error", expect.any(McpTimeoutError));
      expect(then).toHaveBeenCalledOnce();
      expect(then.mock.calls[0]?.[1]).toBeTypeOf("function");
    } finally {
      operation.resolve();
    }
  });

  it("an expired tool cannot leave a late reconnect rejection after owner close", async () => {
    const run = promisify(execFile);
    const fixturePath = fileURLToPath(
      new URL("../../test/fixtures/mcp-deadline-close.ts", import.meta.url),
    );
    const { stdout } = await run(process.execPath, ["--import", "tsx", fixturePath], {
      windowsHide: true,
    });
    expect(JSON.parse(stdout)).toEqual({
      result: "Not connected",
      reconnectAttempts: 0,
      aliveAfterClose: false,
    });
  }, 15_000);

  it("an already aborted timeout waiter still observes the underlying promise", async () => {
    const operation = Promise.withResolvers<void>();
    const then = vi.spyOn(operation.promise, "then");
    const error = new Error("fixture cancellation");
    const waiting = withTimeout(
      operation.promise,
      1_000,
      "fixture timeout",
      AbortSignal.abort(error),
    );
    await expect(waiting).rejects.toBe(error);
    expect(then).toHaveBeenCalledOnce();
    expect(then.mock.calls[0]?.[1]).toBeTypeOf("function");
    operation.resolve();
  });
});

describe("stdio transport startup and native handle ownership", () => {
  it("a closed transport cannot launch another child", async () => {
    const transport = new ProcessTreeStdioClientTransport({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      stderr: "pipe",
    });
    transports.add(transport);
    await transport.start();
    await transport.close();
    expect(transport.processAlive).toBe(false);
    await expect(transport.start()).rejects.toThrow("closed");
    expect(transport.processAlive).toBe(false);
  });

  it.runIf(process.platform === "win32")(
    "close waits for a delayed Windows Job Object and releases it once",
    async () => {
      const entered = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<{ terminate: () => void; close: () => void }>();
      const job = { terminate: vi.fn(), close: vi.fn() };
      const transport = new ProcessTreeStdioClientTransport(
        { command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] },
        {
          windowsJobObjectFactory: () => {
            entered.resolve();
            return gate.promise;
          },
        },
      );
      transports.add(transport);
      const starting = observe(transport.start());
      await entered.promise;
      let closed = false;
      const closing = transport.close().then(() => {
        closed = true;
      });
      try {
        await nextTurn();
        expect(closed).toBe(false);
        gate.resolve(job);
        await Promise.all([starting, closing, transport.close()]);
        expect(job.terminate).toHaveBeenCalledOnce();
        expect(job.close).toHaveBeenCalledOnce();
        expect(transport.processAlive).toBe(false);
      } finally {
        gate.resolve(job);
        await Promise.all([starting, closing]);
      }
    },
  );
});
