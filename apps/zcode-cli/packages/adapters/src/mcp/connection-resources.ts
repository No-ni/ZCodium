import type { Client, SSEClientTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { Logger } from "@zcode/contracts";
import type { McpConnectionContext } from "./pool-types.js";
import type { McpProcessTracker } from "./process-tracker.js";
import { terminateMcpStdioProcessTree } from "./process-tree.js";
import { ProcessTreeStdioClientTransport } from "./stdio-transport.js";

export type McpClient = Client;
export type McpTransport = StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;

export function createMcpResourceCloser(options: {
  connectionContext?: McpConnectionContext;
  logger?: Logger;
  processTracker?: McpProcessTracker;
}) {
  const closingResources = new WeakMap<McpClient | McpTransport, Promise<void>>();
  const closeResources = async (
    name: string,
    client?: McpClient,
    transport?: McpTransport,
  ): Promise<void> => {
    const startedAt = Date.now();
    const mcpTransportPid = transport instanceof StdioClientTransport ? transport.pid : undefined;
    if (client) client.onclose = undefined;
    // 自有 stdio transport 已统一等待启动、Job Object 和进程树；其他 SDK transport 保留原回收边界。
    if (
      mcpTransportPid != null &&
      !(transport instanceof ProcessTreeStdioClientTransport)
    ) {
      try {
        await terminateMcpStdioProcessTree(mcpTransportPid);
      } catch (error) {
        options.logger?.warn("MCP stdio process tree cleanup failed", {
          ...options.connectionContext,
          error: error instanceof Error ? error.message : String(error),
          event: "mcp.stdio.process_tree_cleanup.failed",
          mcpServerName: name,
          mcpTransportPid,
          pid: mcpTransportPid,
          status: "failed",
        });
      }
    }
    try {
      await client?.close();
    } catch (error) {
      options.logger?.debug("MCP client close failed", {
        error: error instanceof Error ? error.message : String(error),
        event: "mcp.client.close.failed",
        mcpServerName: name,
      });
    }
    try {
      await transport?.close();
    } catch (error) {
      options.logger?.debug("MCP transport close failed", {
        error: error instanceof Error ? error.message : String(error),
        event: "mcp.transport.close.failed",
        mcpServerName: name,
      });
    }
    if (
      options.connectionContext &&
      transport instanceof ProcessTreeStdioClientTransport &&
      !transport.processAlive
    ) {
      options.processTracker?.recordProcessClosed({
        connectionId: options.connectionContext.mcpConnectionId,
      });
    }
    options.logger?.info("MCP server closed", {
      ...options.connectionContext,
      durationMs: Date.now() - startedAt,
      event: "mcp.server.closed",
      mcpServerName: name,
      ...(mcpTransportPid != null ? { mcpTransportPid } : {}),
      status: "completed",
    });
  };

  return (name: string, client?: McpClient, transport?: McpTransport): Promise<void> => {
    const resource = transport ?? client;
    if (!resource) return Promise.resolve();
    const existing = closingResources.get(resource);
    if (existing) return existing;
    // record.close 与启动失败可能同时回收；这里只等资源，不反向等待启动 Promise，避免循环等待。
    const closing = Promise.resolve().then(() => closeResources(name, client, transport));
    closingResources.set(resource, closing);
    return closing;
  };
}
