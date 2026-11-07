import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  createRequestCompressionFetch,
  type RequestCompressionState,
} from "../src/model/request-compression/index.js";

const ENDPOINT = "https://api.example.com/v1/messages";
// 用长重复正文，避免小报文压缩后反而变大而让体积断言失去意义。
const JSON_BODY = JSON.stringify({
  model: "m",
  messages: Array.from({ length: 200 }, () => ({
    role: "user",
    content: "hello world ".repeat(20),
  })),
});

function captureFetch(respond?: () => Response) {
  const captured: Array<{ request: Request }> = [];
  const impl = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    captured.push({ request: new Request(input, init) });
    return respond ? respond() : new Response("ok");
  });
  return { captured, impl };
}

function createState(): RequestCompressionState {
  return { brotliUnsupported: false };
}

describe("request compression fetch", () => {
  it("returns the inner fetch untouched when compression is off", async () => {
    const { captured, impl } = captureFetch();
    const fetch = createRequestCompressionFetch({
      fetch: impl,
      providerId: "demo",
      algorithm: "off",
    });

    expect(fetch).toBe(impl);

    await fetch(ENDPOINT, {
      body: JSON_BODY,
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(captured[0]?.request.headers.has("content-encoding")).toBe(false);
  });

  it("brotli-compresses a JSON body and drops the stale content-length", async () => {
    const { captured, impl } = captureFetch();
    const fetch = createRequestCompressionFetch({
      fetch: impl,
      providerId: "demo",
      algorithm: "brotli",
      state: createState(),
    });

    await fetch(ENDPOINT, {
      body: JSON_BODY,
      headers: { "content-type": "application/json", "content-length": String(JSON_BODY.length) },
      method: "POST",
    });

    const request = captured[0]!.request;
    expect(request.headers.get("content-encoding")).toBe("br");
    const compressed = Buffer.from(await request.arrayBuffer());
    expect(compressed.byteLength).toBeLessThan(Buffer.byteLength(JSON_BODY));
    expect(brotliDecompressSync(compressed).toString("utf8")).toBe(JSON_BODY);
    // 运行时按压缩后字节重算：旧 content-length 必须删掉，否则与正文不符。
    expect(request.headers.has("content-length")).toBe(false);
  });

  it("gzip-compresses when configured", async () => {
    const { captured, impl } = captureFetch();
    const fetch = createRequestCompressionFetch({
      fetch: impl,
      providerId: "demo",
      algorithm: "gzip",
      state: createState(),
    });

    await fetch(ENDPOINT, {
      body: JSON_BODY,
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    const request = captured[0]!.request;
    expect(request.headers.get("content-encoding")).toBe("gzip");
    expect(gunzipSync(Buffer.from(await request.arrayBuffer())).toString("utf8")).toBe(JSON_BODY);
  });

  it("downgrades to gzip once when the gateway rejects brotli, and remembers it", async () => {
    const state = createState();
    const { captured, impl } = captureFetch(() => new Response("unsupported", { status: 415 }));
    const fetch = createRequestCompressionFetch({
      fetch: impl,
      providerId: "demo",
      algorithm: "brotli",
      state,
    });
    const init = {
      body: JSON_BODY,
      headers: { "content-type": "application/json" },
      method: "POST",
    };

    const response = await fetch(ENDPOINT, init);

    expect(response.status).toBe(415);
    expect(state.brotliUnsupported).toBe(true);
    expect(captured.map((entry) => entry.request.headers.get("content-encoding"))).toEqual([
      "br",
      "gzip",
    ]);

    // 记忆生效后不再先试 brotli。
    await fetch(ENDPOINT, init);
    expect(captured[2]?.request.headers.get("content-encoding")).toBe("gzip");
  });

  it("downgrades to gzip when the inner transport throws a provider error with the status", async () => {
    const state = createState();
    const encodings: Array<string | null> = [];
    const impl = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      encodings.push(new Request(input, init).headers.get("content-encoding"));
      // 内层 business-error 层会把非 2xx 抛成错误；降级判断必须能从结构化字段读回状态码。
      throw Object.assign(new Error("provider business error"), { statusCode: 415 });
    });
    const fetch = createRequestCompressionFetch({
      fetch: impl,
      providerId: "demo",
      algorithm: "brotli",
      state,
    });

    await expect(
      fetch(ENDPOINT, {
        body: JSON_BODY,
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    ).rejects.toThrow("provider business error");

    expect(encodings).toEqual(["br", "gzip"]);
    expect(state.brotliUnsupported).toBe(true);
  });

  it("skips a request whose body the caller already encoded", async () => {
    const { captured, impl } = captureFetch();
    const fetch = createRequestCompressionFetch({
      fetch: impl,
      providerId: "demo",
      algorithm: "brotli",
      state: createState(),
    });

    await fetch(ENDPOINT, {
      body: JSON_BODY,
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
      method: "POST",
    });

    const request = captured[0]!.request;
    // 二次编码会把正文写坏：已编码的正文必须原样保留，不能叠加压缩。
    expect(request.headers.get("content-encoding")).toBe("gzip");
    await expect(request.text()).resolves.toBe(JSON_BODY);
  });

  it("leaves non-JSON bodies untouched", async () => {
    const { captured, impl } = captureFetch();
    const fetch = createRequestCompressionFetch({
      fetch: impl,
      providerId: "demo",
      algorithm: "brotli",
      state: createState(),
    });

    await fetch(ENDPOINT, {
      body: "not-json",
      headers: { "content-type": "text/plain" },
      method: "POST",
    });

    const request = captured[0]!.request;
    expect(request.headers.has("content-encoding")).toBe(false);
    await expect(request.text()).resolves.toBe("not-json");
  });
});
