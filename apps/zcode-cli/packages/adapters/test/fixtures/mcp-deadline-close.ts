import { Client } from "@modelcontextprotocol/client";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createMcpAdapter } from "../../src/mcp/index.js";
import { terminateMcpStdioProcessTree } from "../../src/mcp/process-tree.js";
import { ProcessTreeStdioClientTransport } from "../../src/mcp/stdio-transport.js";

const echo = fileURLToPath(
  new URL("../../../../../../scripts/ci/fixtures/mcp-echo.mjs", import.meta.url),
);
const transports = new Set<ProcessTreeStdioClientTransport>();
const originalStart = ProcessTreeStdioClientTransport.prototype.start;
const originalCall = Client.prototype.callTool;
const originalNow = Date.now;
ProcessTreeStdioClientTransport.prototype.start = function () {
  transports.add(this);
  return originalStart.call(this);
};
const adapter = createMcpAdapter({ workingDirectory: tmpdir() });
const internal = adapter as unknown as { reconnectForCall(...args: unknown[]): Promise<void> };
const originalReconnect = internal.reconnectForCall.bind(internal);
let reconnectAttempts = 0;
internal.reconnectForCall = (...args) => {
  reconnectAttempts++;
  return originalReconnect(...args);
};
const entered = Promise.withResolvers<void>();
const late = Promise.withResolvers<Awaited<ReturnType<Client["callTool"]>>>();
try {
  const status = await adapter.connectServer("fixture", {
    type: "stdio",
    command: process.execPath,
    args: [echo],
    protocolVersion: "legacy",
    timeoutMs: 3_000,
  });
  if (status.status !== "connected") throw new Error("Fixture stdio did not connect");
  Client.prototype.callTool = function () {
    entered.resolve();
    return late.promise;
  };
  let clock = originalNow();
  Date.now = () => clock;
  const calling = adapter
    .callTool({ serverName: "fixture", toolName: "echo" }, { timeoutMs: 1_000 })
    .then(
      () => "completed",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
  await entered.promise;
  clock += 1_001;
  late.reject(new Error("Not connected"));
  const result = await calling;
  Date.now = originalNow;
  await adapter.close();
  await nextTurn();
  await nextTurn();
  process.stdout.write(
    JSON.stringify({
      result,
      reconnectAttempts,
      aliveAfterClose: [...transports].some((transport) => transport.processAlive),
    }) + "\n",
  );
} finally {
  Date.now = originalNow;
  Client.prototype.callTool = originalCall;
  late.resolve({ content: [] });
  await adapter.close();
  for (const transport of transports) {
    if (transport.pid) await terminateMcpStdioProcessTree(transport.pid);
    await transport.close();
  }
  ProcessTreeStdioClientTransport.prototype.start = originalStart;
}
