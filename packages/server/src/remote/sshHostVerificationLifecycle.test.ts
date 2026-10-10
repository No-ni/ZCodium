import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import ssh2, { type Connection } from "ssh2";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SSHBackend } from "./ssh-backend.js";
import { SSHHostKeyStore, type HostKeyVerdict } from "./sshKnownHosts.js";

const hostKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  type: "pkcs1",
  format: "pem",
});
const match: HostKeyVerdict = {
  outcome: "match",
  record: {
    algorithm: "sha256",
    fingerprint: "a".repeat(64),
    firstSeenAt: "fixture",
    lastSeenAt: "fixture",
  },
};
const changed: HostKeyVerdict = {
  outcome: "reject",
  reason: "changed",
  expected: "a".repeat(64),
  received: "b".repeat(64),
};
let server: ssh2.Server;
let backend: SSHBackend;
let peers: Array<{ client: Connection; closed: Promise<unknown> }>;

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  peers = [];
  server = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
    client.on("error", () => {});
    peers.push({ client, closed: once(client, "close") });
    client.on("authentication", (context) => context.reject());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing loopback address");
  backend = new SSHBackend({
    host: "127.0.0.1",
    port: address.port,
    username: "fixture",
    password: "fixture",
  });
});

afterEach(async () => {
  backend.dispose();
  for (const peer of peers) peer.client.end();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.all(peers.map((peer) => peer.closed));
  vi.restoreAllMocks();
});

// 真实 ssh2 的已销毁握手不能接收迟到 verify(false)；mock Client 无法复现这个崩溃。
it.each<HostKeyVerdict>([
  match,
  changed,
  { outcome: "reject", reason: "store-error", detail: "fixture" },
])("取消后忽略异步校验 $outcome/$reason，并结束握手等待", async (verdict) => {
  const entered = deferred();
  const delayed = deferred<HostKeyVerdict>();
  vi.spyOn(SSHHostKeyStore.prototype, "verify").mockImplementation(async () => {
    entered.resolve();
    return delayed.promise;
  });
  let failure: unknown;
  const detection = backend.detect().catch((error) => {
    failure = error;
  });
  try {
    await entered.promise;
    backend.dispose();
    await peers[0]!.closed;
    delayed.resolve(verdict);
    await vi.waitFor(() => {
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("已释放");
    });
    await detection;
  } finally {
    delayed.resolve(match);
  }
});

it("旧校验迟到不污染重试连接或回调已关闭的握手", async () => {
  const entered = deferred();
  const retried = deferred();
  const first = deferred<HostKeyVerdict>();
  const second = deferred<HostKeyVerdict>();
  vi.spyOn(SSHHostKeyStore.prototype, "verify")
    .mockImplementationOnce(async () => {
      entered.resolve();
      return first.promise;
    })
    .mockImplementationOnce(async () => {
      retried.resolve();
      return second.promise;
    });
  let firstFailure: unknown;
  const detection = backend.detect().catch((error) => {
    firstFailure = error;
  });
  try {
    await entered.promise;
    peers[0]!.client.end();
    await peers[0]!.closed;
    await vi.waitFor(() => expect(firstFailure).toBeInstanceOf(Error));
    await detection;
    const retry = expect(backend.detect()).rejects.toThrow("SSH 认证失败");
    await retried.promise;
    first.resolve(changed);
    await setImmediate();
    second.resolve(match);
    await retry;
  } finally {
    first.resolve(match);
    second.resolve(match);
  }
});

it("并发调用复用正在等待主机密钥校验的握手", async () => {
  const entered = deferred();
  const delayed = deferred<HostKeyVerdict>();
  const verify = vi.spyOn(SSHHostKeyStore.prototype, "verify").mockImplementation(async () => {
    entered.resolve();
    return delayed.promise;
  });
  const first = expect(backend.detect()).rejects.toThrow("SSH 认证失败");
  try {
    await entered.promise;
    const second = expect(backend.detect()).rejects.toThrow("SSH 认证失败");
    delayed.resolve(match);
    await Promise.all([first, second]);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(peers).toHaveLength(1);
  } finally {
    delayed.resolve(match);
  }
});
