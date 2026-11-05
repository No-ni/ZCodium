import assert from "node:assert/strict";
import { once } from "node:events";
import { createConnection } from "node:net";
import test from "node:test";
import { startRelayServer } from "../../../packages/relay/src/server.ts";

const options = {
  port: 0,
  host: "127.0.0.1",
  path: "/ws",
  mobileDir: null,
  maxPhysicalFrameBytes: 1024,
  pairTtlMs: 60_000,
  logger: { info() {}, warn() {} },
  rateLimiter: { allowConnect: () => true, allowFrame: () => true },
};

test("监听失败释放已创建的 sweep timer", async (t) => {
  const created = [];
  const cleared = [];
  const originalSet = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  t.mock.method(globalThis, "setInterval", (...args) => {
    const timer = originalSet(...args);
    created.push(timer);
    return timer;
  });
  t.mock.method(globalThis, "clearInterval", (timer) => {
    cleared.push(timer);
    return originalClear(timer);
  });
  try {
    await assert.rejects(startRelayServer({ ...options, port: -1 }), {
      code: "ERR_SOCKET_BAD_PORT",
    });
    assert.equal(created.length, 1);
    assert.deepEqual(cleared, created);
  } finally {
    for (const timer of created) originalClear(timer);
  }
});

test("异步端口占用失败也释放 sweep，保留原监听实例", async (t) => {
  const owner = await startRelayServer(options);
  t.after(() => owner.close());
  const created = [];
  const cleared = [];
  const originalSet = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  t.mock.method(globalThis, "setInterval", (...args) => {
    const timer = originalSet(...args);
    created.push(timer);
    return timer;
  });
  t.mock.method(globalThis, "clearInterval", (timer) => {
    cleared.push(timer);
    return originalClear(timer);
  });
  try {
    await assert.rejects(startRelayServer({ ...options, port: owner.port }), {
      code: "EADDRINUSE",
    });
    assert.equal(created.length, 1);
    assert.deepEqual(cleared, created);
    const response = await fetch(`http://127.0.0.1:${owner.port}/healthz`);
    assert.equal(response.status, 200);
  } finally {
    for (const timer of created) originalClear(timer);
  }
});

test("重复 close 等待同一次释放，未回复 WS close ACK 的客户端不能拖住停机", async (t) => {
  const relay = await startRelayServer(options);
  const client = createConnection({ host: options.host, port: relay.port });
  client.on("error", () => {});
  t.after(async () => {
    client.destroy();
    await relay.close();
  });
  await once(client, "connect");
  const upgraded = once(client, "data");
  client.write(
    "GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
  );
  assert.match(String((await upgraded)[0]), /^HTTP\/1\.1 101/);
  // 原始客户端消费字节但不执行 WS close 握手，复现半开对端而不暂停 TCP 读取。
  client.resume();
  const closed = once(client, "close", { signal: AbortSignal.timeout(2000) });
  const first = relay.close();
  const second = relay.close();
  assert.equal(first, second);
  await Promise.all([first, closed]);
  assert.equal(client.destroyed, true);
});
