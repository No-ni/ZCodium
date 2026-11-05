import assert from "node:assert/strict";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { WebSocket } from "ws";
import {
  Emitter,
  VSBuffer,
  SocketProtocol,
  ChannelClient,
} from "../../../packages/rpc/src/index.ts";
import {
  IConversationShareService,
  ServiceCollection,
} from "../../../packages/services/src/index.ts";
import { createProjectTestFixture } from "../project-test-sandbox.mjs";

const output = await createProjectTestFixture("http-owner");
const bundle = join(output, "http.mjs");
const requireFromServer = createRequire(
  resolve(import.meta.dirname, "../../../packages/server/package.json"),
);
await build({
  stdin: {
    contents:
      'export { createHttpServer } from "./http.ts"; export { connections, deferNextConnection } from "./remote/index.js";',
    resolveDir: resolve(import.meta.dirname, "../../../packages/server/src"),
  },
  outfile: bundle,
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  plugins: [
    {
      name: "fixture-remote-owner",
      setup(builder) {
        builder.onResolve({ filter: /^(?:@|[a-z])/ }, (args) =>
          args.path.startsWith("node:")
            ? undefined
            : { path: pathToFileURL(requireFromServer.resolve(args.path)).href, external: true },
        );
        builder.onResolve({ filter: /^\.\/remote\/index\.js$/ }, () => ({
          path: "transport",
          namespace: "fixture",
        }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          contents: `
        export const connections = [];
        let pending;
        export function deferNextConnection() {
          let resume, started;
          pending = { gate: new Promise(done => { resume = done; }), ready: new Promise(done => { started = done; }), started };
          return { resume, ready: pending.ready };
        }
        export async function createRemoteBackend(target) { return { target, dispose() {} }; }
        export async function connectRemote(backend, options) {
          const blocked = pending; pending = undefined;
          let released;
          const connection = {
            services: { fileService: {}, gitService: {}, systemService: { async info() { return { fixture: true }; } }, terminalService: {} },
            releases: 0, released: new Promise(done => { released = done; }), options,
            dispose() { this.releases++; released(); },
            async disposeAndWait() { this.releases++; await this.releaseGate; released(); }
          };
          connections.push(connection);
          blocked?.started();
          if (blocked) await blocked.gate;
          return connection;
        }
      `,
        }));
      },
    },
  ],
});
const { createHttpServer, connections, deferNextConnection } = await import(
  pathToFileURL(bundle).href
);

async function fixture(services = new ServiceCollection()) {
  const server = createHttpServer(services, 0, { host: "127.0.0.1", serverId: "fixture" });
  if (!server.listening) await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    server,
    origin,
    async connect() {
      const response = await fetch(origin + "/api/connect-remote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "ssh", host: "fixture.invalid", username: "fixture" }),
      });
      assert.equal(response.status, 200);
      return { id: (await response.json()).id, connection: connections.at(-1) };
    },
    async close() {
      await new Promise((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      );
    },
  };
}

async function rpc(url) {
  const ws = new WebSocket(url);
  const data = new Emitter(),
    close = new Emitter();
  ws.on("message", (bytes) => data.fire(VSBuffer.wrap(bytes)));
  ws.on("close", () => close.fire());
  const protocol = new SocketProtocol({
    onData: data.event,
    onClose: close.event,
    onEnd: close.event,
    write: (buffer) => ws.send(buffer.buffer),
    end: () => ws.close(),
    drain: async () => {},
    dispose: () => ws.close(),
  });
  const client = new ChannelClient(protocol);
  // open 与首个 Initialize 可在同一 data 回调补发；订阅不能等到 await continuation。
  await once(ws, "open");
  return {
    ws,
    client,
    async close() {
      const closed = once(ws, "close");
      ws.close();
      await closed;
      client.dispose();
      protocol.dispose();
      data.dispose();
      close.dispose();
    },
  };
}

test("remote WebSocket close releases the original transport once", async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  const { id, connection } = await context.connect();
  const remote = await rpc(context.origin.replace("http", "ws") + "/ws/remote/" + id);
  assert.deepEqual(await remote.client.getChannel("system").call("info"), { fixture: true });
  await remote.close();
  await connection.released;
  assert.equal(connection.releases, 1);
});

test("server close releases unconsumed remote IDs", async () => {
  const context = await fixture();
  const { connection } = await context.connect();
  await context.close();
  assert.equal(connection.releases, 1);
});

test("remote IDs and server disposal are isolated between HTTP instances", async (t) => {
  const first = await fixture(),
    second = await fixture();
  t.after(async () => {
    if (first.server.listening) await first.close();
    if (second.server.listening) await second.close();
  });
  const { id, connection } = await first.connect();
  const foreign = new WebSocket(second.origin.replace("http", "ws") + "/ws/remote/" + id);
  const rejected = once(foreign, "close");
  await rejected;
  assert.equal(connection.releases, 0);
  await second.close();
  assert.equal(connection.releases, 0);
  const owned = await rpc(first.origin.replace("http", "ws") + "/ws/remote/" + id);
  await owned.close();
  await connection.released;
  assert.equal(connection.releases, 1);
});

test("server close terminates upgraded sockets and releases their transport", async () => {
  const context = await fixture();
  const { id, connection } = await context.connect();
  const remote = await rpc(context.origin.replace("http", "ws") + "/ws/remote/" + id);
  const closed = once(remote.ws, "close");
  await context.close();
  await closed;
  remote.client.dispose();
  assert.equal(connection.releases, 1);
});

test("socket and server close await the same in-flight transport disposal", async () => {
  const context = await fixture();
  const { id, connection } = await context.connect();
  let resume;
  connection.releaseGate = new Promise((done) => {
    resume = done;
  });
  const remote = await rpc(context.origin.replace("http", "ws") + "/ws/remote/" + id);
  await remote.close();
  let finished = false;
  const closing = context.close().then(() => {
    finished = true;
  });
  await new Promise((done) => setImmediate(done));
  assert.equal(finished, false);
  assert.equal(connection.releases, 1);
  resume();
  await closing;
  assert.equal(connection.releases, 1);
});

test("a connection finishing after close starts is released instead of published", async () => {
  const context = await fixture();
  const blocked = deferNextConnection();
  const request = fetch(context.origin + "/api/connect-remote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "ssh", host: "fixture.invalid", username: "fixture" }),
  }).catch(() => null);
  await blocked.ready;
  const connection = connections.at(-1);
  const closing = context.close();
  blocked.resume();
  const response = await request;
  assert.equal(response?.status, 503);
  await closing;
  assert.equal(connection.releases, 1);
  assert.equal(connection.options.signal.aborted, true);
});

test("concurrent close starts ready transport disposal while another handshake is pending", async () => {
  const context = await fixture();
  const { connection: ready } = await context.connect();
  const blocked = deferNextConnection();
  const request = fetch(context.origin + "/api/connect-remote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "ssh", host: "fixture.invalid", username: "fixture" }),
  }).catch(() => null);
  await blocked.ready;
  const late = connections.at(-1);
  let finished = 0;
  const first = context.close().then(() => {
    finished++;
  });
  const second = context.close().then(() => {
    finished++;
  });
  try {
    await new Promise((done) => setImmediate(done));
    assert.equal(ready.releases, 1);
    assert.equal(late.releases, 0);
    assert.equal(finished, 0);
  } finally {
    blocked.resume();
    const response = await request;
    assert.equal(response?.status, 503);
    await Promise.all([first, second]);
  }
  assert.equal(finished, 2);
  assert.equal(ready.releases, 1);
  assert.equal(late.releases, 1);
});

test("ordinary replayable WebSocket cannot call the base archive service", async (t) => {
  let calls = 0;
  const services = new ServiceCollection().register(IConversationShareService, {
    async getCapabilities() {
      calls++;
      return { fixture: true };
    },
    async preflight() {
      calls++;
      return { fixture: true };
    },
  });
  const context = await fixture(services);
  t.after(() => context.close());
  const socket = await rpc(context.origin.replace("http", "ws") + "/ws");
  try {
    await assert.rejects(
      socket.client.getChannel(IConversationShareService.channelName).call("getCapabilities"),
    );
    await assert.rejects(
      socket.client.getChannel(IConversationShareService.channelName).call("preflight", {}),
    );
    assert.equal(calls, 0);
  } finally {
    await socket.close();
  }
});
