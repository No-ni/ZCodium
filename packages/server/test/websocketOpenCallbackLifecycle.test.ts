import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { WebSocket as NodeWebSocket, WebSocketServer } from "ws";
import { connectViaWebSocket } from "@zcode/client";
import { ChannelClient, SocketProtocol } from "@zcode/rpc";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";

test("pinned Hono Node adapter serves HTTP and exchanges a real WebSocket message", async () => {
  const app = new Hono();
  const { upgradeWebSocket, injectWebSocket, wss } = createNodeWebSocket({ app });
  app.get("/health", (c) => c.text("ready"));
  app.get(
    "/socket",
    upgradeWebSocket(() => ({
      onMessage(event, socket) {
        socket.send(`echo:${String(event.data)}`);
      },
    })),
  );
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  injectWebSocket(server);
  let socket: NodeWebSocket | undefined;
  try {
    if (!server.listening) await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/health`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ready");
    socket = new NodeWebSocket(`ws://127.0.0.1:${address.port}/socket`);
    await once(socket, "open");
    const message = once(socket, "message");
    socket.send("synthetic-message");
    assert.equal(String((await message)[0]), "echo:synthetic-message");
  } finally {
    socket?.terminate();
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

async function loopbackServer() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `ws://127.0.0.1:${address.port}`,
    async dispose() {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

test("open callback close rejects the connection and releases RPC before native close", async (t) => {
  const server = await loopbackServer();
  const clientDispose = t.mock.method(ChannelClient.prototype, "dispose");
  const protocolDispose = t.mock.method(SocketProtocol.prototype, "dispose");
  let observeClose!: () => void;
  const closed = new Promise<void>((resolve) => {
    observeClose = resolve;
  });
  let observeRelease!: (counts: number[]) => void;
  const released = new Promise<number[]>((resolve) => {
    observeRelease = resolve;
  });
  let closeFields: unknown;
  let releasedInClose: number[] | undefined;
  const connection = connectViaWebSocket(server.url, {
    onOpenSocket(socket) {
      socket.close(1000, "fixture-init-close");
      assert.equal(socket.readyState, WebSocket.CLOSING);
      queueMicrotask(() => {
        observeRelease([clientDispose.mock.calls.length, protocolDispose.mock.calls.length]);
      });
    },
    onClose(event) {
      closeFields = event;
      releasedInClose = [clientDispose.mock.calls.length, protocolDispose.mock.calls.length];
      observeClose();
    },
  });
  // 在任何断言前观察拒绝，避免失败清理期间出现无人观察的异步拒绝。
  const outcome = connection.then(
    () => "resolved",
    (error: unknown) => error,
  );
  try {
    const releaseCounts = await released;
    await closed;
    const result = await outcome;
    assert.ok(result instanceof Error, "closing in the callback must not report a ready service");
    assert.match(result.message, /closed before ready: fixture-init-close/);
    assert.deepEqual(releaseCounts, [1, 1]);
    assert.deepEqual(closeFields, { code: 1000, reason: "fixture-init-close", wasClean: true });
    assert.deepEqual(releasedInClose, [1, 1]);
    assert.equal(clientDispose.mock.calls.length, 1);
    assert.equal(protocolDispose.mock.calls.length, 1);
  } finally {
    await server.dispose();
    await closed;
    await outcome;
  }
});

test("open callback failure preserves the error and disposes the connection once", async (t) => {
  const server = await loopbackServer();
  const clientDispose = t.mock.method(ChannelClient.prototype, "dispose");
  const protocolDispose = t.mock.method(SocketProtocol.prototype, "dispose");
  const failure = new Error("FIXTURE_OPEN_CALLBACK_FAILURE");
  let observeClose!: () => void;
  const closed = new Promise<void>((resolve) => {
    observeClose = resolve;
  });
  const connection = connectViaWebSocket(server.url, {
    onOpenSocket() {
      throw failure;
    },
    onClose() {
      observeClose();
    },
  });
  try {
    await assert.rejects(connection, (error) => error === failure);
    await closed;
    assert.equal(clientDispose.mock.calls.length, 1);
    assert.equal(protocolDispose.mock.calls.length, 1);
  } finally {
    await server.dispose();
  }
});

test("normal open callback still resolves usable service proxies before close", async (t) => {
  const server = await loopbackServer();
  const clientDispose = t.mock.method(ChannelClient.prototype, "dispose");
  const protocolDispose = t.mock.method(SocketProtocol.prototype, "dispose");
  let socket: WebSocket | undefined;
  let observeClose!: () => void;
  const closed = new Promise<void>((resolve) => {
    observeClose = resolve;
  });
  const connection = connectViaWebSocket(server.url, {
    onOpenSocket(value) {
      socket = value;
    },
    onClose() {
      observeClose();
    },
  });
  try {
    const services = await connection;
    assert.equal(socket?.readyState, WebSocket.OPEN);
    assert.equal(typeof services.systemService.info, "function");
    assert.equal(clientDispose.mock.calls.length, 0);
    assert.equal(protocolDispose.mock.calls.length, 0);
    socket?.close(1000, "fixture-normal-close");
    await closed;
    assert.equal(clientDispose.mock.calls.length, 1);
    assert.equal(protocolDispose.mock.calls.length, 1);
  } finally {
    socket?.close();
    await server.dispose();
  }
});
