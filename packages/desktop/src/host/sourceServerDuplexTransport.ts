import { Agent, request } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket } from "ws";

export async function createSourceHttpAgent(
  createConnection: () => Promise<Duplex>,
): Promise<Agent> {
  const stream = (await createConnection()) as Duplex & {
    ref(): unknown;
    unref(): unknown;
    setKeepAlive(): unknown;
    setNoDelay(): unknown;
    setTimeout(): unknown;
  };
  stream.ref ??= () => stream;
  stream.unref ??= () => stream;
  stream.setKeepAlive ??= () => stream;
  stream.setNoDelay ??= () => stream;
  stream.setTimeout ??= () => stream;
  const agent = new Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
  let used = false;
  agent.createConnection = (() => {
    if (used) throw new Error("Source handshake attempted a second connection");
    used = true;
    return stream;
  }) as Agent["createConnection"];
  return agent;
}
export async function requestSourceJson(
  agent: Agent,
  path: string,
  token: string,
  method: "GET" | "POST",
  signal?: AbortSignal,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request(
      `http://source-server.invalid${path}`,
      {
        agent,
        method,
        signal,
        headers: { connection: "keep-alive", authorization: `Bearer ${token}` },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.once("error", reject);
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1_048_576) {
            response.destroy(new Error("Source response limit exceeded"));
            return;
          }
          chunks.push(chunk);
        });
        response.once("end", () => {
          if (response.statusCode !== 200) {
            reject(new Error("Source authentication or handshake failed"));
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(new Error("Invalid Source response"));
          }
        });
      },
    );
    req.once("error", reject);
    req.end();
  });
}
export async function openSourceWebSocket(
  agent: Agent,
  token: string,
  capability: string,
  onCreated: (socket: WebSocket) => void,
  signal?: AbortSignal,
): Promise<WebSocket> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = new WebSocket("ws://source-server.invalid/ws/host", {
      agent,
      headers: { authorization: `Bearer ${token}`, "x-zcode-rpc-host-capability": capability },
    });
    onCreated(socket);
    const abort = () => {
      socket.terminate();
      reject(new Error("Source connection canceled"));
    };
    const cleanup = () => signal?.removeEventListener("abort", abort);
    signal?.addEventListener("abort", abort, { once: true });
    socket.once("open", () => {
      cleanup();
      resolve(socket);
    });
    socket.once("error", (error) => {
      cleanup();
      reject(error);
    });
    socket.once("close", () => {
      cleanup();
      reject(new Error("Source closed during handshake"));
    });
    if (signal?.aborted) abort();
  });
}
