import { randomUUID } from "node:crypto";
import { relative, resolve } from "node:path";
import type { McpConnectOptions, McpServerConfig, McpServerStatus } from "@zcode/contracts";
import type { McpConnectionContext, McpConnectionPoolOptions, PoolEntry } from "./pool-types.js";

const DEFAULT_IDLE_GRACE_MS = 30_000;

/** entry registry 唯一拥有连接、引用、探测与资源关闭状态；lease 只持有引用。 */
export function createMcpEntryRegistry(options: McpConnectionPoolOptions) {
  const entries = new Map<string, PoolEntry>();
  const closingEntries = new Map<PoolEntry, Promise<void>>();
  const closedEntries = new WeakMap<PoolEntry, Promise<void>>();
  const idleGraceMs = options.idleGraceMs ?? DEFAULT_IDLE_GRACE_MS;
  const logger = options.logger?.child({ module: "adapters.mcp.pool" });
  let closed = false;
  let closePromise: Promise<void> | undefined;

  const closeEntry = (entry: PoolEntry): Promise<void> => {
    // 失败退休后的旧 lease 仍持有 entry；保留对象级关闭结果，不能因 active map 摘除而重复 close。
    const pending = closedEntries.get(entry);
    if (pending) return pending;
    const startedAt = Date.now();
    if (entry.closeTimer) clearTimeout(entry.closeTimer);
    entry.closeTimer = undefined;
    if (entries.get(entry.key) === entry) entries.delete(entry.key);
    const closing = Promise.resolve().then(async () => {
      try {
        await entry.adapter.close();
        logger?.info("MCP pooled connection closed", {
          ...entry.connectionContext,
          durationMs: Date.now() - startedAt,
          event: "mcp.pool.connection.closed",
          mcpServerName: entry.serverName,
          status: "completed",
        });
      } catch (error) {
        logger?.warn("MCP pooled connection close failed", {
          ...entry.connectionContext,
          error: error instanceof Error ? error.message : String(error),
          event: "mcp.pool.connection.close.failed",
          mcpServerName: entry.serverName,
        });
      } finally {
        options.processTracker?.unregisterConnection({
          connectionId: entry.connectionContext.mcpConnectionId,
        });
        closingEntries.delete(entry);
      }
    });
    closingEntries.set(entry, closing);
    closedEntries.set(entry, closing);
    return closing;
  };

  const connectEntry = (
    entry: PoolEntry,
    config: McpServerConfig,
    connectOptions: McpConnectOptions,
  ): Promise<McpServerStatus> =>
    Promise.resolve().then(async () => {
      try {
        // 引用先登记、外部 IO 后启动；关闭或移除先到时，不能向已退休 adapter 迟到 launch。
        if (closed || entries.get(entry.key) !== entry || entry.refs.size === 0)
          throw new Error("MCP connection was closed before startup");
        return await entry.adapter.connectServer(entry.serverName, config, connectOptions);
      } catch (error) {
        // 同步抛错和异步拒绝都由已登记 entry 回收，不留下不可追踪的 adapter 或失败缓存。
        await closeEntry(entry);
        throw error;
      }
    });

  const scheduleClose = (entry: PoolEntry): void => {
    if (entry.closeTimer) return;
    if (idleGraceMs <= 0) {
      void closeEntry(entry);
      return;
    }
    entry.closeTimer = setTimeout(() => {
      entry.closeTimer = undefined;
      if (entry.refs.size === 0) void closeEntry(entry);
    }, idleGraceMs);
    entry.closeTimer.unref?.();
  };

  // 设置页的 mcpPort 是进程级的 `protocol-settings` lease，connectionKey 只由
  // serverName + leaseId + config 组成，配置没变时每次 mcp/list 都命中同一个 entry 并直接返回
  // 首次连接那个早已 resolve 的 promise——不重连、不探测、不打日志。HTTP/SSE MCP 被停掉又不会
  // 派发 onclose，于是设置页永远显示"已连接并可用"，点多少次刷新都不变。
  // 这里在显式要求 revalidate 时先确认连接仍然存活，已死则在同一个 entry 上原地重连
  // （保持 entry 身份，其他共享该连接的 lease 不会被打断成 "not leased"）。
  const revalidateEntry = async (
    entry: PoolEntry,
    config: McpServerConfig,
    connectOptions: McpConnectOptions,
  ): Promise<void> => {
    if (entry.revalidating) {
      await entry.revalidating;
      return;
    }
    const run = (async () => {
      const connected = await entry.connecting.then(
        () => true,
        () => false,
      );
      const state = connected
        ? (await entry.adapter.status())[entry.serverName]?.status
        : undefined;
      // 探测期间最后一个 owner 或整个 pool 可能已关闭，迟到结果不能复活已退休的 adapter。
      if (closed || entries.get(entry.key) !== entry) return;
      // 进行中的握手（含 OAuth 待授权）和显式停用/待信任状态不打扰：
      // 重连会作废浏览器里已打开的授权 URL 和 PKCE/state。
      if (state === "connecting" || state === "disabled" || state === "untrusted") {
        return;
      }
      if (state === "connected") {
        const alive = (await entry.adapter.pingServer?.(entry.serverName)) ?? true;
        if (closed || entries.get(entry.key) !== entry) return;
        if (alive) {
          logger?.debug("MCP pooled connection revalidated", {
            ...entry.connectionContext,
            event: "mcp.pool.connection.revalidated",
            mcpServerName: entry.serverName,
            status: "completed",
          });
          return;
        }
      }
      logger?.warn("MCP pooled connection is stale; reconnecting", {
        ...entry.connectionContext,
        event: "mcp.pool.connection.stale",
        mcpConnectionState: state ?? "unknown",
        mcpServerName: entry.serverName,
        status: "started",
      });
      entry.connecting = connectEntry(entry, config, connectOptions);
      // 失败由 status()/调用方 await entry.connecting 表达，这里不重复冒泡。
      await entry.connecting.catch(() => undefined);
    })();
    entry.revalidating = run.finally(() => {
      entry.revalidating = undefined;
    });
    await entry.revalidating;
  };

  return {
    entries,
    logger,
    isClosed: () => closed,
    isCurrent: (entry: PoolEntry) => entries.get(entry.key) === entry,
    createEntry(input: {
      key: string;
      serverName: string;
      config: McpServerConfig;
      connectOptions: McpConnectOptions;
      sessionId?: string;
    }): PoolEntry {
      const { key, serverName, config, connectOptions, sessionId } = input;
      const connectionContext = createConnectionContext({ config, connectOptions, sessionId });
      options.processTracker?.registerConnection({
        connectionId: connectionContext.mcpConnectionId,
        isolation: connectionContext.mcpIsolation,
        serverName,
        ...(config.source ? { source: config.source.kind } : {}),
      });
      let adapter;
      try {
        adapter = options.createAdapter({
          connectionContext,
          config,
          serverName,
          workingDirectory: connectOptions.workingDirectory,
        });
      } catch (error) {
        options.processTracker?.unregisterConnection({
          connectionId: connectionContext.mcpConnectionId,
        });
        throw error;
      }
      const cwd = executionDirectory(config, connectOptions);
      const entry: PoolEntry = {
        adapter,
        connectionContext,
        connecting: undefined!,
        key,
        refs: new Set(),
        serverName,
        executionScoped:
          config.type === "stdio" &&
          Boolean(
            config.cwd &&
            cwd &&
            connectOptions.workingDirectory &&
            relative(resolve(connectOptions.workingDirectory), cwd) !== "",
          ),
      };
      entries.set(key, entry);
      entry.connecting = connectEntry(entry, config, connectOptions);
      logger?.info("MCP pooled connection created", {
        ...connectionContext,
        event: "mcp.pool.connection.created",
        mcpServerName: serverName,
        transport: config.type,
      });
      return entry;
    },
    retireIfUnused(entry: PoolEntry): Promise<void> | undefined {
      const closing = closedEntries.get(entry);
      if (closing) return closing;
      if (entry.refs.size !== 0) return;
      // 只有 workspace 根共享连接有复用宽限；会话 cwd 的最后一个 owner 必须等子进程释放。
      if (entry.connectionContext.mcpIsolation === "session" || entry.executionScoped)
        return closeEntry(entry);
      scheduleClose(entry);
    },
    revalidateEntry,
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closed = true;
      const pending = [...entries.values()];
      entries.clear();
      // 活跃 map 已摘除的 entry 仍可能持有进程；重复 close 共用同一资源完成边界。
      closePromise = Promise.all([...pending.map(closeEntry), ...closingEntries.values()]).then(
        () => undefined,
      );
      return closePromise;
    },
    stats() {
      return {
        activeConnections: entries.size,
        pendingCloseConnections: [...entries.values()].filter((entry) => entry.refs.size === 0)
          .length,
      };
    },
  };
}

export function createConnectionContext(input: {
  config: McpServerConfig;
  connectOptions: McpConnectOptions;
  sessionId?: string;
}): McpConnectionContext {
  const mcpIsolation = input.config.isolation === "workspace" ? "workspace" : "session";
  const workspaceKey = resolveWorkspaceKey(input.connectOptions);
  return {
    mcpConnectionId: randomUUID(),
    mcpIsolation,
    ...(workspaceKey ? { workspaceKey } : {}),
    ...(mcpIsolation === "session" && input.sessionId ? { sessionId: input.sessionId } : {}),
  };
}

function resolveWorkspaceKey(connectOptions: McpConnectOptions): string | undefined {
  return (
    connectOptions.workspaceIdentity?.trim() || connectOptions.workingDirectory?.trim() || undefined
  );
}

function executionDirectory(config: McpServerConfig, connectOptions: McpConnectOptions): string {
  if (config.type !== "stdio") return "";
  return resolve(connectOptions.workingDirectory?.trim() || process.cwd(), config.cwd || ".");
}

export function connectionKey(input: {
  config: McpServerConfig;
  connectOptions: McpConnectOptions;
  leaseId: string;
  serverName: string;
}): string {
  // settings lease 跨 workspace 使用；session 必须同时隔离 lease/身份，stdio 还依赖实际执行 cwd。
  const workspaceKey = resolveWorkspaceKey(input.connectOptions) ?? "";
  const scope = input.config.isolation === "workspace" ? "" : input.leaseId;
  return stableStringify([
    input.serverName,
    scope,
    workspaceKey,
    executionDirectory(input.config, input.connectOptions),
    input.config,
  ]);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .toSorted()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}
