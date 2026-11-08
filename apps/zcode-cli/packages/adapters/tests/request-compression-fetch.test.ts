import { readFile } from "node:fs/promises";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  createRegistryModelConfig,
  createRegistryProviderConfig,
  parseProviderConfig,
  parseZCodeBuiltinModelConfigRules,
} from "@zcode/provider";
import { AiSdkModelAdapter } from "../src/model/runner.js";
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

// 回归：压缩层曾被错误地放在 option map 之外，导致 map 层拿不到明文正文而 fail-closed，
// 报 "Model option maps require a JSON text request body."，请求根本发不出去。
// 这里贯通到 SDK 序列化与 wire 字节，锁定「map 先改写明文、压缩最后上网」的顺序。
describe("compression layered under model option maps", () => {
  it("keeps the plaintext body available to option maps and compresses only afterwards", async () => {
    const provider = createRegistryProviderConfig(
      parseProviderConfig({
        group: "standard-personal",
        access: { type: "api-key", apiKey: "fixture" },
        api: {
          type: "openai-chat-completions",
          baseUrl: "https://fixture.invalid/v1",
          requestCompression: "brotli",
        },
      }),
    );
    if (!provider.ok) throw new Error("invalid fixture");

    let encoding: string | null | undefined;
    let wireBody: unknown;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const bytes = new Uint8Array(await request.arrayBuffer());
      encoding = request.headers.get("content-encoding");
      wireBody =
        encoding === "br" ? JSON.parse(brotliDecompressSync(bytes).toString("utf8")) : undefined;
      return Response.json({
        id: "fixture",
        object: "chat.completion",
        created: 1,
        model: "glm-5.3-flash",
        choices: [
          { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    });

    const release = JSON.parse(
      await readFile(
        new URL("../../../../../config/provider/zcode-builtin.json", import.meta.url),
        "utf8",
      ),
    );
    const rules = parseZCodeBuiltinModelConfigRules(release.config.modelConfigRules);
    const builtin = createRegistryModelConfig(
      rules.resolve({
        providerId: "fixture",
        modelId: "glm-5.3-flash",
        apiType: "openai-chat-completions",
        baseUrl: "https://fixture.invalid/v1",
      }),
    );
    if (!builtin.ok) throw new Error("invalid fixture");
    // 只替换 optionSpecs：其余字段保持真实 Model 配置，避免把契约定死在测试里。
    const modelConfig = {
      ...builtin.config,
      optionSpecs: {
        reasoningLevel: { values: ["high"], map: "{}" },
        maxOutputTokens: { max: 8192, map: "{}" },
      },
    } as typeof builtin.config;

    try {
      const adapter = new AiSdkModelAdapter({ env: {}, retry: { maxAttempts: 1 } });
      const model = adapter.createModel({
        providerId: "fixture",
        modelId: "glm-5.3-flash",
        modelConfig,
        providerConfig: provider.config,
        options: { reasoningLevel: "high", maxOutputTokens: 4096 },
      });
      await model.generateText({
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(encoding).toBe("br");
    expect(wireBody).toMatchObject({ model: "glm-5.3-flash" });
  });
});
