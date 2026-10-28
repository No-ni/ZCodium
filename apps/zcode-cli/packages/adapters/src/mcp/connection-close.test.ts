import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { McpServerConfig } from "@zcode/contracts";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpAdapter, createMcpAdapterConnectionPool } from "./index.js";
import { createInteractiveAuthorizationRequiredError } from "./oauth-errors.js";
import { terminateMcpStdioProcessTree } from "./process-tree.js";
import { ProcessTreeStdioClientTransport } from "./stdio-transport.js";

const echo = fileURLToPath(
  new URL("../../../../../../scripts/ci/fixtures/mcp-echo.mjs", import.meta.url),
);
const config: McpServerConfig = {
  type: "stdio",
  command: process.execPath,
  args: [echo],
  timeoutMs: 3_000,
};
const transports = new Set<ProcessTreeStdioClientTransport>();
const originalStart = ProcessTreeStdioClientTransport.prototype.start;

afterEach(async () => {
  vi.restoreAllMocks();
  for (const transport of transports) {
    if (transport.pid) await terminateMcpStdioProcessTree(transport.pid);
    await transport.close();
  }
  transports.clear();
});

function recordTransports() {
  vi.spyOn(ProcessTreeStdioClientTransport.prototype, "start").mockImplementation(
    function (this: ProcessTreeStdioClientTransport) {
      transports.add(this);
      return originalStart.call(this);
    },
  );
}
function observe<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}

describe("MCP live connection close compatibility", () => {
  it.each(["legacy", "auto"] as const)(
    "%s connects, calls and closes a real stdio peer",
    async (protocolVersion) => {
      recordTransports();
      const adapter = createMcpAdapter({ workingDirectory: tmpdir() });
      try {
        const status = await adapter.connectServer("fixture", { ...config, protocolVersion });
        expect(status.status, status.error).toBe("connected");
        expect((await adapter.listTools()).map((tool) => tool.toolName)).toEqual(["echo"]);
        const result = await adapter.callTool({
          serverName: "fixture",
          toolName: "echo",
          arguments: { value: "fixture" },
        });
        expect(JSON.parse(result.content[0]!.text as string).arguments).toEqual({
          value: "fixture",
        });
        await Promise.all([adapter.close(), adapter.close()]);
        expect([...transports].some((transport) => transport.processAlive)).toBe(false);
        expect(await adapter.status()).toEqual({});
      } finally {
        await adapter.close();
      }
    },
  );

  it("modern pin failure reaps the disposable probe without starting a session child", async () => {
    recordTransports();
    const adapter = createMcpAdapter({ workingDirectory: tmpdir() });
    try {
      expect(
        await adapter.connectServer("fixture", { ...config, protocolVersion: "2026-07-28" }),
      ).toMatchObject({ status: "failed", failureKind: "protocol_negotiation_failed" });
      expect(transports.size).toBe(1);
      expect([...transports].some((transport) => transport.processAlive)).toBe(false);
    } finally {
      await adapter.close();
    }
  });

  it.each(["auto", "2026-07-28"] as const)(
    "%s owner close during a real probe cannot launch a late session child",
    async (protocolVersion) => {
      recordTransports();
      const sent = Promise.withResolvers<void>();
      const originalSend = ProcessTreeStdioClientTransport.prototype.send;
      vi.spyOn(ProcessTreeStdioClientTransport.prototype, "send").mockImplementation(
        function (this: ProcessTreeStdioClientTransport, message) {
          const result = originalSend.call(this, message);
          if ("method" in message && message.method === "server/discover") sent.resolve();
          return result;
        },
      );
      const adapter = createMcpAdapter({ workingDirectory: tmpdir() });
      const connecting = observe(
        adapter.connectServer("fixture", {
          ...config,
          args: ["-e", "setInterval(() => {}, 1000)"],
          protocolVersion,
        }),
      );
      try {
        await sent.promise;
        await adapter.close();
        await connecting;
        expect(transports.size).toBe(1);
        expect([...transports].some((transport) => transport.processAlive)).toBe(false);
        expect(await adapter.status()).toEqual({});
      } finally {
        await adapter.close();
        await connecting;
      }
    },
  );

  it("a surviving workspace owner remains callable after the other lease closes", async () => {
    recordTransports();
    const pool = createMcpAdapterConnectionPool({ workingDirectory: tmpdir() });
    const a = pool.acquireLease();
    const b = pool.acquireLease();
    try {
      const shared: McpServerConfig = {
        ...config,
        isolation: "workspace",
        protocolVersion: "legacy",
      };
      await a.connectServer("fixture", shared, { workingDirectory: tmpdir() });
      await b.connectServer("fixture", shared, { workingDirectory: tmpdir() });
      await a.close();
      expect(transports.size).toBe(1);
      expect(await b.callTool({ serverName: "fixture", toolName: "echo" })).toHaveProperty(
        "content",
      );
      await b.close();
      expect([...transports].some((transport) => transport.processAlive)).toBe(true);
      await pool.close();
      expect([...transports].some((transport) => transport.processAlive)).toBe(false);
    } finally {
      await a.close();
      await b.close();
      await pool.close();
    }
  });

  it("a delayed disconnect cannot overwrite the newer same-name record", async () => {
    recordTransports();
    const adapter = createMcpAdapter({ workingDirectory: tmpdir() });
    await adapter.connectServer("fixture", { ...config, protocolVersion: "legacy" });
    const internal = adapter as unknown as {
      closeClientAndTransport(...args: unknown[]): Promise<void>;
    };
    const closeResources = internal.closeClientAndTransport.bind(internal);
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    vi.spyOn(internal, "closeClientAndTransport").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await gate.promise;
      await closeResources(...args);
    });
    const disconnecting = adapter.disconnectServer("fixture");
    try {
      await entered.promise;
      const newer = adapter.connectServer("fixture", { ...config, enabled: false });
      gate.resolve();
      await Promise.all([disconnecting, newer]);
      expect((await adapter.status()).fixture?.status).toBe("disabled");
    } finally {
      gate.resolve();
      await disconnecting;
      await adapter.close();
    }
  });

  it("OAuth caller budget preserves the shared transaction while owner close aborts it", async () => {
    vi.spyOn(Client.prototype, "connect").mockImplementation(async () => {
      throw createInteractiveAuthorizationRequiredError({
        serverName: "fixture",
        reason: "unauthorized",
      });
    });
    const adapter = createMcpAdapter();
    const entered = Promise.withResolvers<AbortSignal>();
    const internal = adapter as unknown as {
      runInteractiveOAuthAuthorization(input: {
        signal: AbortSignal;
      }): Promise<{ status: "failed"; error: unknown }>;
    };
    vi.spyOn(internal, "runInteractiveOAuthAuthorization").mockImplementation(({ signal }) => {
      entered.resolve(signal);
      return new Promise((resolve) => {
        const finish = () => resolve({ status: "failed", error: signal.reason });
        if (signal.aborted) finish();
        else signal.addEventListener("abort", finish, { once: true });
      });
    });
    try {
      const connecting = adapter.connectServer(
        "fixture",
        {
          type: "http",
          url: "https://fixture.example.invalid/mcp",
          protocolVersion: "legacy",
          oauth: { type: "authorization_code" },
        },
        { oauthAuthorizationTimeoutMs: 1 },
      );
      const signal = await entered.promise;
      expect((await connecting).status).toBe("connecting");
      await nextTurn();
      expect(signal.aborted).toBe(false);
      await adapter.close();
      expect(signal.aborted).toBe(true);
      expect(await adapter.status()).toEqual({});
    } finally {
      await adapter.close();
    }
  });

  it("concurrent OAuth tool failures still join one connection-owned recovery", async () => {
    vi.spyOn(Client.prototype, "connect").mockImplementation(async () => undefined);
    vi.spyOn(Client.prototype, "listTools").mockImplementation(async () => ({ tools: [] }));
    const adapter = createMcpAdapter();
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const config: McpServerConfig = {
      type: "http",
      url: "https://fixture.example.invalid/mcp",
      protocolVersion: "legacy",
      oauth: { type: "authorization_code" },
    };
    await adapter.connectServer("fixture", config);
    const internal = adapter as unknown as {
      callToolOnClient(...args: unknown[]): Promise<{ content: unknown[] }>;
      runInteractiveOAuthAuthorization(...args: unknown[]): Promise<{ status: "authorized" }>;
    };
    const failedCalls = Promise.withResolvers<void>();
    let attempts = 0;
    const call = vi.spyOn(internal, "callToolOnClient").mockImplementation(async () => {
      if (++attempts <= 2) {
        if (attempts === 2) failedCalls.resolve();
        await failedCalls.promise;
        throw createInteractiveAuthorizationRequiredError({
          serverName: "fixture",
          reason: "unauthorized",
        });
      }
      return { content: [] };
    });
    const authorize = vi
      .spyOn(internal, "runInteractiveOAuthAuthorization")
      .mockImplementation(async () => {
        entered.resolve();
        await gate.promise;
        return { status: "authorized" };
      });
    const a = observe(adapter.callTool({ serverName: "fixture", toolName: "fixture" }));
    let secondDone = false;
    const b = observe(adapter.callTool({ serverName: "fixture", toolName: "fixture" })).then(
      (result) => {
        secondDone = true;
        return result;
      },
    );
    await entered.promise;
    try {
      await nextTurn();
      expect(secondDone).toBe(false);
      gate.resolve();
      expect(await a).toHaveProperty("value");
      expect(await b).toHaveProperty("value");
      expect(authorize).toHaveBeenCalledOnce();
      expect(call).toHaveBeenCalledTimes(4);
    } finally {
      gate.resolve();
      await Promise.all([a, b]);
      await adapter.close();
    }
  });

  it.each(["authorization", "disconnected"] as const)(
    "a late old-client %s failure reuses completed recovery without closing current calls",
    async (failure) => {
      const adapter = createMcpAdapter();
      const internal = adapter as unknown as {
        createTransport(...args: unknown[]): Promise<{ transport: InMemoryTransport }>;
        callToolOnClient(...args: unknown[]): Promise<unknown>;
        runInteractiveOAuthAuthorization(...args: unknown[]): Promise<{ status: "authorized" }>;
      };
      const peers: Array<{ server: InMemoryTransport; close: ReturnType<typeof vi.spyOn> }> = [];
      const started = Promise.withResolvers<void>();
      const retrySent = Promise.withResolvers<void>();
      const oldA = Promise.withResolvers<unknown>();
      const oldB = Promise.withResolvers<unknown>();
      const pending: Array<{ server: InMemoryTransport; id: string | number }> = [];
      vi.spyOn(internal, "createTransport").mockImplementation(async () => {
        const [client, server] = InMemoryTransport.createLinkedPair();
        const index = peers.length;
        peers.push({ server, close: vi.spyOn(client, "close") });
        server.onmessage = (message) => {
          if (!("method" in message) || !("id" in message)) return;
          let result: Record<string, unknown> = {};
          if (message.method === "initialize") {
            result = {
              protocolVersion: "2025-11-25",
              capabilities: { tools: {} },
              serverInfo: { name: "fixture", version: "1" },
            };
          } else if (message.method === "tools/list") {
            result = { tools: [{ name: "fixture", inputSchema: { type: "object" } }] };
          } else if (message.method === "tools/call") {
            if (index === 1) {
              pending.push({ server, id: message.id });
              retrySent.resolve();
              return;
            }
            result = { content: [] };
          }
          void server.send({ jsonrpc: "2.0", id: message.id, result });
        };
        await server.start();
        return { transport: client };
      });
      const authorize = vi
        .spyOn(internal, "runInteractiveOAuthAuthorization")
        .mockResolvedValue({ status: "authorized" });
      const config: McpServerConfig = {
        type: "http",
        url: "https://fixture.example.invalid/mcp",
        protocolVersion: "legacy",
        timeoutMs: 3_000,
        oauth: { type: "authorization_code" },
      };
      let a: Promise<unknown> | undefined;
      let b: Promise<unknown> | undefined;
      try {
        expect((await adapter.connectServer("fixture", config)).status).toBe("connected");
        const callOnClient = internal.callToolOnClient.bind(internal);
        let calls = 0;
        const call = vi.spyOn(internal, "callToolOnClient").mockImplementation((...args) => {
          if (++calls === 1) return oldA.promise;
          if (calls === 2) {
            started.resolve();
            return oldB.promise;
          }
          return callOnClient(...args);
        });
        a = observe(adapter.callTool({ serverName: "fixture", toolName: "fixture" }));
        b = observe(adapter.callTool({ serverName: "fixture", toolName: "fixture" }));
        await started.promise;
        oldA.reject(
          createInteractiveAuthorizationRequiredError({
            serverName: "fixture",
            reason: "unauthorized",
          }),
        );
        await retrySent.promise;
        oldB.reject(
          failure === "authorization"
            ? createInteractiveAuthorizationRequiredError({
                serverName: "fixture",
                reason: "unauthorized",
              })
            : new Error("Not connected"),
        );
        await nextTurn();
        expect(authorize).toHaveBeenCalledOnce();
        expect(peers).toHaveLength(2);
        expect(peers[1]!.close).not.toHaveBeenCalled();
        expect(pending).toHaveLength(2);
        for (const request of pending)
          await request.server.send({ jsonrpc: "2.0", id: request.id, result: { content: [] } });
        expect(await a).toHaveProperty("value");
        expect(await b).toHaveProperty("value");
        const currentClient = call.mock.calls[2]?.[0];
        call.mockImplementationOnce(async () => {
          throw createInteractiveAuthorizationRequiredError({
            serverName: "fixture",
            reason: "unauthorized",
          });
        });
        expect(
          await adapter.callTool({ serverName: "fixture", toolName: "fixture" }),
        ).toHaveProperty("content");
        expect(call.mock.calls[4]?.[0]).toBe(currentClient);
        expect(authorize).toHaveBeenCalledTimes(2);
        expect(peers).toHaveLength(3);
        expect(peers[1]!.close).toHaveBeenCalled();
      } finally {
        oldA.resolve({ content: [] });
        oldB.resolve({ content: [] });
        await adapter.close();
        await Promise.all([a, b]);
        for (const peer of peers) await peer.server.close();
      }
    },
  );

  it("owner close settles a pending real SDK tool request", async () => {
    recordTransports();
    const sent = Promise.withResolvers<void>();
    const originalSend = ProcessTreeStdioClientTransport.prototype.send;
    vi.spyOn(ProcessTreeStdioClientTransport.prototype, "send").mockImplementation(
      function (this: ProcessTreeStdioClientTransport, message) {
        const result = originalSend.call(this, message);
        if ("method" in message && message.method === "tools/call") sent.resolve();
        return result;
      },
    );
    const source = `
      const { createInterface } = require('node:readline');
      createInterface({ input: process.stdin }).on('line', (line) => {
        const message = JSON.parse(line);
        if (!('id' in message) || message.method === 'tools/call') return;
        const result = message.method === 'initialize'
          ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
          : message.method === 'tools/list' ? { tools: [{ name: 'wait', inputSchema: { type: 'object' } }] } : {};
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
      });
    `;
    const adapter = createMcpAdapter({ workingDirectory: tmpdir() });
    let calling: Promise<unknown> | undefined;
    try {
      expect(
        (
          await adapter.connectServer("fixture", {
            ...config,
            args: ["-e", source],
            protocolVersion: "legacy",
          })
        ).status,
      ).toBe("connected");
      let completed = false;
      calling = observe(adapter.callTool({ serverName: "fixture", toolName: "wait" })).then(
        (result) => {
          completed = true;
          return result;
        },
      );
      await sent.promise;
      await adapter.close();
      await nextTurn();
      expect(completed).toBe(true);
      expect(await calling).toHaveProperty("error");
    } finally {
      await adapter.close();
      await calling;
    }
  });

  it("a tool caller cancellation does not destroy a live connection", async () => {
    recordTransports();
    const sent = Promise.withResolvers<void>();
    const originalCall = Client.prototype.callTool;
    vi.spyOn(Client.prototype, "callTool").mockImplementation(function (this: Client, ...args) {
      const calling = originalCall.apply(this, args);
      sent.resolve();
      return calling;
    });
    const adapter = createMcpAdapter({ workingDirectory: tmpdir() });
    try {
      expect(
        (await adapter.connectServer("fixture", { ...config, protocolVersion: "legacy" })).status,
      ).toBe("connected");
      const controller = new AbortController();
      const calling = observe(
        adapter.callTool(
          { serverName: "fixture", toolName: "echo" },
          { signal: controller.signal },
        ),
      );
      await sent.promise;
      controller.abort(new Error("fixture cancellation"));
      expect(await calling).toHaveProperty("error");
      expect(await adapter.pingServer?.("fixture")).toBe(true);
      expect(await adapter.callTool({ serverName: "fixture", toolName: "echo" })).toHaveProperty(
        "content",
      );
    } finally {
      await adapter.close();
    }
  });
});
