import { tmpdir } from "node:os";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createMcpAdapter, createMcpConnectionPool } from "../../src/mcp/index.js";
import { terminateMcpStdioProcessTree } from "../../src/mcp/process-tree.js";
import { ProcessTreeStdioClientTransport } from "../../src/mcp/stdio-transport.js";

const transports = new Set<ProcessTreeStdioClientTransport>();
const start = ProcessTreeStdioClientTransport.prototype.start;
ProcessTreeStdioClientTransport.prototype.start = function () {
  transports.add(this);
  return start.call(this);
};
const pool = createMcpConnectionPool({
  createAdapter: () => createMcpAdapter({ workingDirectory: tmpdir() }),
});
const lease = pool.acquireLease();
const connecting = lease.connectServer("fixture", {
  type: "stdio",
  command: process.execPath,
  args: ["-e", "setInterval(() => {}, 1000)"],
  protocolVersion: "legacy",
  timeoutMs: 1_000,
}).then(
  () => "connected",
  () => "rejected",
);
try {
  const turns = Number(process.argv[2]);
  for (let turn = 0; turn < turns; turn++) await Promise.resolve();
  await lease.close();
  const aliveAfterLeaseClose = [...transports].some((transport) => transport.processAlive);
  await pool.close();
  const aliveAfterPoolClose = [...transports].some((transport) => transport.processAlive);
  const result = await connecting;
  await nextTurn();
  await nextTurn();
  process.stdout.write(JSON.stringify({
    aliveAfterLeaseClose,
    aliveAfterPoolClose,
    result,
    activeConnections: pool.stats().activeConnections,
  }) + "\n");
} finally {
  for (const transport of transports) {
    if (transport.pid) await terminateMcpStdioProcessTree(transport.pid);
    await transport.close();
  }
  await lease.close();
  await pool.close();
}
