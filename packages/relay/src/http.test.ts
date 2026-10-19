import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startRelayServer, type RelayServerHandle } from "./server.js";

let root: string;
let relay: RelayServerHandle;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zcode-relay-http-"));
  await writeFile(join(root, "mobile.html"), "relay mobile fixture");
  relay = await startRelayServer({
    port: 0,
    host: "127.0.0.1",
    path: "/ws",
    maxPhysicalFrameBytes: 1024,
    pairTtlMs: 60_000,
    mobileDir: root,
    logger: { info() {}, warn() {} },
    rateLimiter: { allowConnect: () => true, allowFrame: () => true },
  });
});
afterEach(async () => {
  await relay.close();
  await rm(root, { recursive: true, force: true });
});

describe("relay HTTP request validation", () => {
  it.each(["/%", "/%E0%A4%A", "/%FF"])(
    "损坏编码 %s 返回 400，健康和页面服务不中断",
    async (path) => {
      const base = `http://127.0.0.1:${relay.port}`;
      const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(1000) });
      expect(response.status).toBe(400);
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
      expect(await (await fetch(`${base}/`)).text()).toBe("relay mobile fixture");
    },
  );
});
