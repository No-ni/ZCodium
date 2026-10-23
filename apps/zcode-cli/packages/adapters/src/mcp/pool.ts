import type {
  McpCallToolOptions,
  McpCallToolRequest,
  McpConnectOptions,
  McpConnectionSnapshot,
  McpPort,
  McpReadResourceRequest,
  McpReadResourceResult,
  McpServerConfig,
  McpServerStatus,
  McpToolCallResult,
  McpToolDescriptor,
} from "@zcode/contracts";
import { connectionKey, createMcpEntryRegistry } from "./pool-entries.js";
import type { McpConnectionPool, McpConnectionPoolOptions, PoolEntry } from "./pool-types.js";
export type {
  McpConnectionContext,
  McpConnectionPool,
  McpConnectionPoolOptions,
} from "./pool-types.js";

export function createMcpConnectionPool(options: McpConnectionPoolOptions): McpConnectionPool {
  const registry = createMcpEntryRegistry(options);
  const { entries, logger } = registry;
  let leaseSequence = 0;
  const acquireLease = (leaseOptions: { leaseId?: string; sessionId?: string } = {}): McpPort => {
    if (registry.isClosed()) throw new Error("MCP connection pool is closed");
    const leaseId = `${++leaseSequence}:${leaseOptions.leaseId ?? "lease"}`;
    const sessionId = leaseOptions.sessionId?.trim() || undefined;
    const leased = new Map<string, PoolEntry>();
    const configuredServers = new Map<string, McpServerConfig>();
    let configurationGeneration = 0;
    const appListeners = new Map<string, Set<{ listener: () => void; off: () => void }>>();
    const invalidateApps = (serverName: string) => {
      const watchers = appListeners.get(serverName);
      appListeners.delete(serverName);
      for (const watcher of watchers ?? []) {
        watcher.off();
        watcher.listener();
      }
    };
    const pendingReleases = new Set<Promise<void>>();
    let leaseClosed = false;
    let leaseClosePromise: Promise<void> | undefined;
    let sessionStartupReported = false;

    const assertOpen = (): void => {
      if (registry.isClosed() || leaseClosed)
        throw new Error("MCP connection pool or lease is closed");
    };
    const assertConfiguration = (generation: number): void => {
      assertOpen();
      if (generation !== configurationGeneration) throw new Error("MCP configuration was replaced");
    };
    const requireEntry = (serverName: string): PoolEntry => {
      const entry = leased.get(serverName);
      if (!entry || !registry.isCurrent(entry))
        throw new Error(`MCP server is not leased by this session: ${serverName}`);
      return entry;
    };

    const release = (serverName: string): Promise<void> | undefined => {
      const entry = leased.get(serverName);
      if (!entry) return;
      leased.delete(serverName);
      if (entry.refs.delete(leaseId)) {
        options.processTracker?.releaseOwner({
          connectionId: entry.connectionContext.mcpConnectionId,
          ownerId: leaseId,
        });
        logger?.info("MCP connection lease released", {
          ...entry.connectionContext,
          event: "mcp.pool.lease.released",
          mcpLeaseId: leaseId,
          mcpServerName: serverName,
          refCount: entry.refs.size,
          ...(sessionId ? { sessionId } : {}),
        });
      }
      const closing = registry.retireIfUnused(entry);
      if (closing) {
        // 先登记回收结果再通知 App；同步重入 close 不能遗漏已摘掉引用的旧资源。
        pendingReleases.add(closing);
        void closing.then(() => pendingReleases.delete(closing));
      }
      invalidateApps(serverName);
      return closing;
    };

    const acquire = async (
      serverName: string,
      config: McpServerConfig,
      connectOptions: McpConnectOptions = {},
    ): Promise<McpServerStatus> => {
      assertOpen();
      const key = connectionKey({ config, connectOptions, leaseId, serverName });
      const previous = leased.get(serverName);
      const existing = entries.get(key);
      const previousClosing = previous && previous !== existing ? release(serverName) : undefined;
      // 释放通知可同步关闭租约；检查之后才创建/挂载 replacement，不能给 closed owner 添引用。
      let entry: PoolEntry;
      let status: McpServerStatus;
      try {
        assertOpen();
        entry =
          entries.get(key) ??
          registry.createEntry({ key, serverName, config, connectOptions, sessionId });
        if (entry.closeTimer) clearTimeout(entry.closeTimer);
        entry.closeTimer = undefined;
        const ownerAdded = !entry.refs.has(leaseId);
        entry.refs.add(leaseId);
        leased.set(serverName, entry);
        if (ownerAdded) {
          options.processTracker?.acquireOwner({
            connectionId: entry.connectionContext.mcpConnectionId,
            ownerId: leaseId,
            ...(sessionId ? { sessionId } : {}),
          });
        }
        if (previous !== entry) {
          logger?.info("MCP connection lease acquired", {
            ...entry.connectionContext,
            event: "mcp.pool.lease.acquired",
            mcpLeaseId: leaseId,
            mcpServerName: serverName,
            refCount: entry.refs.size,
            ...(sessionId ? { sessionId } : {}),
          });
        }
        // 先同步登记全部引用再等待；外部启动由 registry 延后，关闭不会遗漏 pending admission。
        if (connectOptions.revalidate)
          await registry.revalidateEntry(entry, config, connectOptions);
        status = await entry.connecting;
      } finally {
        await previousClosing;
      }
      assertOpen();
      if (leased.get(serverName) !== entry || !registry.isCurrent(entry))
        throw new Error(`MCP connection was released or replaced: ${serverName}`);
      return status;
    };

    const snapshot = async (
      generation = configurationGeneration,
    ): Promise<McpConnectionSnapshot> => {
      assertConfiguration(generation);
      const statuses: Record<string, McpServerStatus> = {};
      const tools: McpToolDescriptor[] = [];
      for (const [serverName, entry] of leased) {
        if (!registry.isCurrent(entry)) continue;
        const status = (await entry.adapter.status())[serverName];
        assertConfiguration(generation);
        if (!registry.isCurrent(entry) || leased.get(serverName) !== entry)
          throw new Error(`MCP connection was released or replaced: ${serverName}`);
        if (status) statuses[serverName] = status;
        const listed = await entry.adapter.listTools();
        assertConfiguration(generation);
        if (!registry.isCurrent(entry) || leased.get(serverName) !== entry)
          throw new Error(`MCP connection was released or replaced: ${serverName}`);
        tools.push(...listed);
      }
      if (sessionId && !sessionStartupReported) {
        sessionStartupReported = true;
        const enabledServers = [...configuredServers].filter(
          ([, config]) => config.enabled !== false,
        );
        const connectedCount = enabledServers.filter(
          ([serverName]) => statuses[serverName]?.status === "connected",
        ).length;
        options.processTracker?.recordSessionStartup({
          configuredCount: enabledServers.length,
          connectedCount,
          failedCount: enabledServers.length - connectedCount,
          processCount: enabledServers.filter(
            ([serverName, config]) =>
              config.type === "stdio" && statuses[serverName]?.status === "connected",
          ).length,
          sessionId,
        });
      }
      return { statuses, tools };
    };

    return {
      appConnectionSnapshot(serverName) {
        const entry = leased.get(serverName);
        return entry && registry.isCurrent(entry)
          ? (entry.adapter.appConnectionSnapshot?.(serverName) ?? null)
          : null;
      },
      onAppConnectionInvalidated(serverName, listener) {
        const entry = requireEntry(serverName);
        const watchers = appListeners.get(serverName) ?? new Set();
        const watcher = {
          listener,
          off: entry.adapter.onAppConnectionInvalidated?.(serverName, listener) ?? (() => {}),
        };
        watchers.add(watcher);
        appListeners.set(serverName, watchers);
        return () => {
          watcher.off();
          watchers.delete(watcher);
          if (!watchers.size) appListeners.delete(serverName);
        };
      },
      async callTool(
        request: McpCallToolRequest,
        callOptions?: McpCallToolOptions,
      ): Promise<McpToolCallResult> {
        return await requireEntry(request.serverName).adapter.callTool(request, callOptions);
      },
      async readResource(
        request: McpReadResourceRequest,
        callOptions?: McpCallToolOptions,
      ): Promise<McpReadResourceResult> {
        const adapter = requireEntry(request.serverName).adapter;
        if (!adapter.readResource) {
          throw new Error(`MCP adapter does not support resources: ${request.serverName}`);
        }
        return await adapter.readResource(request, callOptions);
      },
      // 资源列表与订阅经同一 entry 的 adapter；登记表在 adapter（连接层）里，多 session 共享。
      async listResources(request, callOptions) {
        const adapter = requireEntry(request.serverName).adapter;
        if (!adapter.listResources) {
          throw new Error(`MCP adapter does not support resources: ${request.serverName}`);
        }
        return await adapter.listResources(request, callOptions);
      },
      async listResourceTemplates(request, callOptions) {
        const adapter = requireEntry(request.serverName).adapter;
        if (!adapter.listResourceTemplates) {
          throw new Error(`MCP adapter does not support resources: ${request.serverName}`);
        }
        return await adapter.listResourceTemplates(request, callOptions);
      },
      async subscribeResource(request, callOptions) {
        const adapter = requireEntry(request.serverName).adapter;
        if (!adapter.subscribeResource) {
          throw new Error(`MCP adapter does not support resources: ${request.serverName}`);
        }
        await adapter.subscribeResource(request, callOptions);
      },
      async unsubscribeResource(request, callOptions) {
        const adapter = requireEntry(request.serverName).adapter;
        if (!adapter.unsubscribeResource) return;
        await adapter.unsubscribeResource(request, callOptions);
      },
      async unsubscribeResourcesBySubscriber(prefix) {
        let released = 0;
        for (const entry of new Set(leased.values())) {
          if (registry.isCurrent(entry) && entry.adapter.unsubscribeResourcesBySubscriber) {
            released += await entry.adapter.unsubscribeResourcesBySubscriber(prefix);
          }
        }
        return released;
      },
      async close(): Promise<void> {
        if (leaseClosePromise) return leaseClosePromise;
        leaseClosed = true;
        configurationGeneration++;
        // close 本身也会发布同步失效通知；先签发 single-flight 结果，再同步释放全部引用。
        const closing = Promise.withResolvers<void>();
        leaseClosePromise = closing.promise;
        try {
          const released = [...leased.keys()].map(release);
          void Promise.all([
            ...released,
            ...pendingReleases,
            ...(registry.isClosed() ? [registry.close()] : []),
          ]).then(() => closing.resolve(), closing.reject);
        } catch (error) {
          closing.reject(error);
        }
        await leaseClosePromise;
      },
      async connectConfiguredServers(
        servers: Record<string, McpServerConfig>,
        connectOptions: McpConnectOptions = {},
      ): Promise<McpConnectionSnapshot> {
        assertOpen();
        const generation = ++configurationGeneration;
        configuredServers.clear();
        for (const [serverName, config] of Object.entries(servers)) {
          configuredServers.set(serverName, config);
        }
        const configuredNames = new Set(Object.keys(servers));
        // 移除与挂载在同一同步 admission 中完成；旧请求不能在 await 后重新添加已删除配置。
        const removed = [...leased.keys()]
          .filter((name) => !configuredNames.has(name))
          .map(release);
        const connecting = Object.entries(servers).map(([serverName, config]) =>
          acquire(serverName, config, connectOptions),
        );
        try {
          await Promise.all(connecting);
        } finally {
          await Promise.all([...removed, ...pendingReleases]);
        }
        assertConfiguration(generation);
        return await snapshot(generation);
      },
      async connectServer(
        serverName: string,
        config: McpServerConfig,
        connectOptions: McpConnectOptions = {},
      ): Promise<McpServerStatus> {
        configurationGeneration++;
        return await acquire(serverName, config, connectOptions);
      },
      async disconnectServer(serverName: string): Promise<McpServerStatus | undefined> {
        configurationGeneration++;
        const captured = leased.get(serverName);
        const entry = captured && registry.isCurrent(captured) ? captured : undefined;
        const statuses = entry?.adapter.status();
        // 先释放当前引用；状态读取的迟到结果不能断开等待期间建立的同名新连接。
        const closing = release(serverName);
        let status: McpServerStatus | undefined;
        try {
          status = (await statuses)?.[serverName];
        } finally {
          await closing;
        }
        return status
          ? {
              ...status,
              status: "disconnected",
              toolCount: 0,
              updatedAt: new Date().toISOString(),
            }
          : undefined;
      },
      async listTools(): Promise<McpToolDescriptor[]> {
        return (await snapshot()).tools;
      },
      toolListRevision(): number {
        let revision = 0;
        for (const entry of new Set(leased.values())) {
          if (registry.isCurrent(entry)) revision += entry.adapter.toolListRevision?.() ?? 0;
        }
        return revision;
      },
      async pingServer(serverName: string, pingOptions?: { timeoutMs?: number }): Promise<boolean> {
        const entry = leased.get(serverName);
        if (!entry || !registry.isCurrent(entry)) return false;
        return (await entry.adapter.pingServer?.(serverName, pingOptions)) ?? true;
      },
      async status(): Promise<Record<string, McpServerStatus>> {
        return (await snapshot()).statuses;
      },
    };
  };

  return { acquireLease, close: registry.close, stats: registry.stats };
}
