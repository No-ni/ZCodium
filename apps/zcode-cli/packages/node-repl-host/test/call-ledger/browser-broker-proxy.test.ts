import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  createNodeReplBrowserBrokerProxy,
  createNodeReplCallLedger,
  type NodeReplBrowserBrokerProxy,
} from "../../src/call-ledger/contract.js";
import { createUpstream, send, trustedMeta } from "./browser-broker-proxy-fixture.js";

// 规格：apps/zcode-cli/docs/design/v2/tool/20-node-repl-call-ledger.md「浏览器代理 broker」。
const UPSTREAM_TOKEN = "u".repeat(64);

describe("node_repl browser broker proxy", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function startProxy(upstream?: { path: string }) {
    const ledger = createNodeReplCallLedger();
    const proxy: NodeReplBrowserBrokerProxy = createNodeReplBrowserBrokerProxy({
      ledger,
      platform: process.platform,
      ...(upstream ? { upstream: { socketPath: upstream.path, token: UPSTREAM_TOKEN } } : {}),
    });
    await proxy.ready;
    cleanups.push(() => proxy.close());
    return { ledger, proxy };
  }

  it("forwards with the upstream token and the call's own session context, ignoring the Worker's", async () => {
    const upstream = await createUpstream((request) => ({
      id: request.id,
      ok: true,
      browsers: [],
    }));
    cleanups.push(() => upstream.close());
    const { ledger, proxy } = await startProxy(upstream);
    const call = ledger.open(trustedMeta);
    const id = randomUUID();

    const response = await send(proxy.connection.socketPath, {
      id,
      token: call.token,
      op: "list",
      // cell 绕过 bridge 时可以自报任意会话；代理必须改写成本次调用的会话。
      runtimeScope: "main",
      sessionId: "someone-else",
    });

    expect(response).toEqual({ id, ok: true, browsers: [] });
    expect(upstream.requests).toEqual([
      {
        id,
        op: "list",
        token: UPSTREAM_TOKEN,
        runtimeScope: "main",
        sessionId: "trusted-session",
        turnId: "turn-1",
        trace: { traceId: "trace-1", spanId: "span-1" },
      },
    ]);
  });

  it("records a successful screenshot in the call's facts and forwards the response unchanged", async () => {
    const image = { base64: "AQID", mimeType: "image/png" };
    const upstream = await createUpstream((request) => ({
      id: request.id,
      ok: true,
      result: { ok: true, image },
    }));
    cleanups.push(() => upstream.close());
    const { ledger, proxy } = await startProxy(upstream);
    const call = ledger.open(trustedMeta);
    const other = ledger.open({ ...trustedMeta, session_id: "other-session" });
    const id = randomUUID();

    const response = await send(proxy.connection.socketPath, {
      id,
      token: call.token,
      op: "execute",
      browserId: "browser-1",
      browserGeneration: 1,
      command: { method: "screenshot" },
    });

    expect(response).toEqual({ id, ok: true, result: { ok: true, image } });
    expect(call.facts.browserScreenshots).toEqual([image]);
    expect(other.facts.browserScreenshots).toEqual([]);
  });

  it("does not record failed screenshots or other commands", async () => {
    const upstream = await createUpstream((request) =>
      (request.command as { method?: string } | undefined)?.method === "screenshot"
        ? {
            id: request.id,
            ok: true,
            result: { ok: false, image: { base64: "AQID", mimeType: "image/png" } },
          }
        : {
            id: request.id,
            ok: true,
            result: { ok: true, image: { base64: "BAUG", mimeType: "image/png" } },
          },
    );
    cleanups.push(() => upstream.close());
    const { ledger, proxy } = await startProxy(upstream);
    const call = ledger.open(trustedMeta);
    const base = { token: call.token, op: "execute", browserId: "browser-1", browserGeneration: 1 };

    await send(proxy.connection.socketPath, {
      ...base,
      id: randomUUID(),
      command: { method: "screenshot" },
    });
    await send(proxy.connection.socketPath, {
      ...base,
      id: randomUUID(),
      command: { method: "title" },
    });

    // 前提：两个请求都确实转发到了上游。
    expect(upstream.requests).toHaveLength(2);
    expect(call.facts.browserScreenshots).toEqual([]);
  });

  it("rejects unknown tokens and tokens of closed calls without reaching upstream", async () => {
    const upstream = await createUpstream((request) => ({
      id: request.id,
      ok: true,
      browsers: [],
    }));
    cleanups.push(() => upstream.close());
    const { ledger, proxy } = await startProxy(upstream);
    const call = ledger.open(trustedMeta);
    call.close();

    for (const token of ["f".repeat(64), call.token]) {
      const id = randomUUID();
      expect(await send(proxy.connection.socketPath, { id, token, op: "list" })).toEqual({
        id,
        ok: false,
        error: "Node REPL browser broker request is not authorized",
      });
    }
    expect(upstream.requests).toEqual([]);
    expect(Object.keys(call.facts).sort()).toEqual(["browserScreenshots", "cuaApps"]);
  });

  // 上游代理的转发口径不变：带本次调用 token 的 list / execute 一律转发，上游报错或断连也照旧回错。
  // 差别在本仓不据此记会话能力标签——官方用 browserUse 派生 x-zcode-session-features 统计请求头，
  // 审计边界要求剥离，账本 facts 只剩展示用途的两个数组（.agents/specs/official-3.17.1-cua.md §3.4）。
  it("forwards list and execute requests whatever upstream answers, without session stats", async () => {
    const upstream = await createUpstream((request, socket) => {
      if (request.op === "list") return { id: request.id, ok: true, browsers: [] };
      if ((request.command as { method?: string }).method === "navigate") {
        return { id: request.id, ok: false, error: "Browser is not connected" };
      }
      // 上游没有回应就断开。
      socket.destroy();
      return undefined;
    });
    cleanups.push(() => upstream.close());
    const { ledger, proxy } = await startProxy(upstream);
    const base = { op: "execute", browserId: "browser-1", browserGeneration: 1 };
    const listed = ledger.open(trustedMeta);
    const rejected = ledger.open(trustedMeta);
    const dropped = ledger.open(trustedMeta);
    const untouched = ledger.open(trustedMeta);

    await send(proxy.connection.socketPath, { id: randomUUID(), token: listed.token, op: "list" });
    const rejectedResponse = await send(proxy.connection.socketPath, {
      ...base,
      id: randomUUID(),
      token: rejected.token,
      command: { method: "navigate", url: "https://example.test" },
    });
    const droppedResponse = await send(proxy.connection.socketPath, {
      ...base,
      id: randomUUID(),
      token: dropped.token,
      command: { method: "title" },
    });

    // 前提：三个请求都转发到了上游，后两个确实失败了。
    expect(upstream.requests).toHaveLength(3);
    expect(rejectedResponse).toMatchObject({ ok: false, error: "Browser is not connected" });
    expect(droppedResponse).toMatchObject({
      ok: false,
      error: "Browser broker closed before returning a response",
    });
    // 前提：请求确实到达过代理（前三条都拿到上游侧的回应或断连错误）。
    for (const call of [listed, rejected, dropped, untouched]) {
      expect(Object.keys(call.facts).sort()).toEqual(["browserScreenshots", "cuaApps"]);
    }
  });

  it("answers the upstream-missing case without writing session-capability facts", async () => {
    const { ledger, proxy } = await startProxy();
    const listed = ledger.open(trustedMeta);
    const other = ledger.open(trustedMeta);

    // 前提：没有上游时代理回原文案，请求确实到达了代理。
    expect(
      await send(proxy.connection.socketPath, {
        id: randomUUID(),
        token: listed.token,
        op: "list",
      }),
    ).toMatchObject({
      ok: false,
      error: "Browser control is unavailable for this node_repl session",
    });
    await send(proxy.connection.socketPath, { id: randomUUID(), token: other.token, op: "close" });

    expect(JSON.stringify(listed.facts)).not.toMatch(/browserUse|computerUse/u);
    expect(other.facts).toEqual({ cuaApps: [], browserScreenshots: [] });
  });

  it("answers with the existing unavailable message when no upstream is configured", async () => {
    const { ledger, proxy } = await startProxy();
    const call = ledger.open(trustedMeta);
    const id = randomUUID();

    expect(await send(proxy.connection.socketPath, { id, token: call.token, op: "list" })).toEqual({
      id,
      ok: false,
      error: "Browser control is unavailable for this node_repl session",
    });
  });

  it("forwards a multi-megabyte screenshot intact and records it", async () => {
    // MR !3219 评审 SG-02：读行要随数据量线性增长；大截图走主线程，不能拖住其他会话。
    const image = { base64: "A".repeat(6 * 1024 * 1024), mimeType: "image/png" };
    const upstream = await createUpstream((request) => ({
      id: request.id,
      ok: true,
      result: { ok: true, image },
    }));
    cleanups.push(() => upstream.close());
    const { ledger, proxy } = await startProxy(upstream);
    const call = ledger.open(trustedMeta);
    const id = randomUUID();

    const response = await send(proxy.connection.socketPath, {
      id,
      token: call.token,
      op: "execute",
      browserId: "browser-1",
      browserGeneration: 1,
      command: { method: "screenshot" },
    });

    expect((response.result as { image: { base64: string } }).image.base64).toHaveLength(
      image.base64.length,
    );
    expect(call.facts.browserScreenshots).toEqual([image]);
  });

  it("keeps the existing overflow messages for oversized requests and responses", async () => {
    // MR !3219 评审 SG-03：超限文案沿用原来的说法——请求超限是上游 broker 的文案，响应超限是
    // Worker 侧 bridge 的文案。
    const upstream = await createUpstream((request) => ({
      id: request.id,
      ok: true,
      result: { ok: true, image: { base64: "B".repeat(33 * 1024 * 1024), mimeType: "image/png" } },
    }));
    cleanups.push(() => upstream.close());
    const { ledger, proxy } = await startProxy(upstream);
    const call = ledger.open(trustedMeta);

    const oversizedRequestId = randomUUID();
    expect(
      await send(proxy.connection.socketPath, {
        id: oversizedRequestId,
        token: call.token,
        op: "list",
        padding: "x".repeat(1024 * 1024 + 1),
      }),
    ).toEqual({
      id: null,
      ok: false,
      error: "Node REPL browser broker request exceeded 1 MiB",
    });
    expect(upstream.requests).toEqual([]);

    const oversizedResponseId = randomUUID();
    expect(
      await send(proxy.connection.socketPath, {
        id: oversizedResponseId,
        token: call.token,
        op: "execute",
        browserId: "browser-1",
        browserGeneration: 1,
        command: { method: "screenshot" },
      }),
    ).toEqual({
      id: oversizedResponseId,
      ok: false,
      error: "Browser broker response exceeded the 32 MiB limit",
    });
    // 前提：响应超限的请求确实转发到了上游。
    expect(upstream.requests).toHaveLength(1);
    expect(call.facts.browserScreenshots).toEqual([]);
  });

  it("closes the upstream connection when the Worker side disconnects first", async () => {
    // 上游不回应，模拟正在执行的长命令；Worker 侧被 abort 后断开，上游必须收到断开（视为取消）。
    const upstream = await createUpstream(() => undefined);
    cleanups.push(() => upstream.close());
    const { ledger, proxy } = await startProxy(upstream);
    const call = ledger.open(trustedMeta);

    const socket = createConnection(proxy.connection.socketPath);
    socket.on("error", () => undefined);
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    socket.write(`${JSON.stringify({ id: randomUUID(), token: call.token, op: "list" })}\n`);
    await expect.poll(() => upstream.requests.length).toBe(1);
    socket.destroy();

    await expect(upstream.closed).resolves.toBeUndefined();
  });
});
