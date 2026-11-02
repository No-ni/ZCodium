import { randomUUID } from "node:crypto";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 浏览器代理 broker 的共享测试夹具：假上游 broker、Worker 侧 bridge 客户端与可信请求元数据。
// 只放夹具，不放用例；场景与断言仍留在同目录的父测试文件。

function socketPath(name: string): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\zcode-ledger-test-${name}-${randomUUID()}`
    : join(tmpdir(), `zlt-${name}-${randomUUID()}.sock`);
}

/** 假的上游浏览器 broker：记录收到的请求，按 respond 回一行 JSON。 */
export async function createUpstream(
  respond: (request: Record<string, unknown>, socket: Socket) => unknown,
): Promise<{
  path: string;
  requests: Record<string, unknown>[];
  closed: Promise<void>;
  close(): Promise<void>;
}> {
  const path = socketPath("upstream");
  const requests: Record<string, unknown>[] = [];
  let markClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  const server: Server = createServer((socket) => {
    let buffer = "";
    socket.on("close", () => markClosed());
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
      requests.push(request);
      const response = respond(request, socket);
      if (response !== undefined) socket.end(`${JSON.stringify(response)}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return {
    path,
    requests,
    closed,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (process.platform !== "win32") await rm(path, { force: true });
    },
  };
}

/** 模拟 Worker 里的浏览器 bridge：发一行请求，读一行响应。 */
export async function send(
  path: string,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let buffer = "";
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.destroy();
      resolve(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
    });
    socket.once("error", reject);
  });
}

export const trustedMeta = {
  runtime_scope: "main",
  session_id: "trusted-session",
  turn_id: "turn-1",
  trace_id: "trace-1",
  span_id: "span-1",
};
