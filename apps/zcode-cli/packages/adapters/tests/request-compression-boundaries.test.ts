import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { createRequestCompressionFetch } from "../src/model/request-compression/index.js";

const ENDPOINT = "https://fixture.invalid/v1/messages";
const BODY = JSON.stringify({ model: "fixture", messages: [{ role: "user", content: "hello" }] });
const INIT: RequestInit = {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: BODY,
};

function createFetch(fetch: typeof globalThis.fetch, state = { brotliUnsupported: false }) {
  return createRequestCompressionFetch({
    fetch,
    algorithm: "brotli",
    providerId: "fixture",
    state,
  });
}

async function decode(request: Request): Promise<string> {
  const bytes = Buffer.from(await request.arrayBuffer());
  return (
    request.headers.get("content-encoding") === "br"
      ? brotliDecompressSync(bytes)
      : gunzipSync(bytes)
  ).toString("utf8");
}

describe("compression retry boundaries", () => {
  it("preserves an ordinary 400 without retrying or consuming its error body", async () => {
    const state = { brotliUnsupported: false };
    const response = Response.json({ error: { code: "invalid_parameter" } }, { status: 400 });
    const transport = vi.fn<typeof globalThis.fetch>(async () => response);
    expect(await createFetch(transport, state)(ENDPOINT, INIT)).toBe(response);
    expect(response.bodyUsed).toBe(false);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(state.brotliUnsupported).toBe(false);
  });

  it("does not remember a downgrade when gzip also fails", async () => {
    const state = { brotliUnsupported: false };
    const encodings: Array<string | null> = [];
    const transport: typeof globalThis.fetch = async (input, init) => {
      encodings.push(new Request(input, init).headers.get("content-encoding"));
      return new Response("unsupported", { status: 415 });
    };
    const fetch = createFetch(transport, state);
    expect((await fetch(ENDPOINT, INIT)).status).toBe(415);
    expect(state.brotliUnsupported).toBe(false);
    await fetch(ENDPOINT, INIT);
    expect(encodings).toEqual(["br", "gzip", "br", "gzip"]);
  });

  it("preserves the final thrown error without remembering a failed downgrade", async () => {
    const state = { brotliUnsupported: false };
    const error = Object.assign(new Error("fixture failure"), { statusCode: 415 });
    const transport = vi.fn<typeof globalThis.fetch>(async () => {
      throw error;
    });
    await expect(createFetch(transport, state)(ENDPOINT, INIT)).rejects.toBe(error);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(state.brotliUnsupported).toBe(false);
  });

  it.each(["responseStatus", "statusCode"])(
    "remembers a successful retry of a structured %s=415",
    async (field) => {
      const state = { brotliUnsupported: false };
      const encodings: Array<string | null> = [];
      const transport: typeof globalThis.fetch = async (input, init) => {
        encodings.push(new Request(input, init).headers.get("content-encoding"));
        if (encodings.length === 1)
          throw Object.assign(new Error("fixture encoding"), { [field]: 415 });
        return Response.json({ ok: true });
      };
      const fetch = createFetch(transport, state);
      expect((await fetch(ENDPOINT, INIT)).ok).toBe(true);
      expect(state.brotliUnsupported).toBe(true);
      await fetch(ENDPOINT, INIT);
      expect(encodings).toEqual(["br", "gzip", "gzip"]);
    },
  );

  it("replays the captured body and headers when the caller mutates its init after sending", async () => {
    const init = {
      ...INIT,
      headers: { "content-type": "application/json", "x-fixture": "initial" },
    };
    const captured: Array<{ text: string; header: string | null }> = [];
    const transport: typeof globalThis.fetch = async (input, sentInit) => {
      const request = new Request(input, sentInit);
      captured.push({ text: await decode(request), header: request.headers.get("x-fixture") });
      if (captured.length === 1) {
        init.body = JSON.stringify({ message: "changed" });
        init.headers["x-fixture"] = "changed";
        return new Response("unsupported", { status: 415 });
      }
      return Response.json({ ok: true });
    };
    await createFetch(transport)(ENDPOINT, init);
    expect(captured).toEqual([
      { text: BODY, header: "initial" },
      { text: BODY, header: "initial" },
    ]);
  });
});

describe("compression input and cancellation boundaries", () => {
  it("does not buffer or re-encode a Request's body stream", async () => {
    const request = new Request(ENDPOINT, {
      ...INIT,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(BODY));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    const transport = vi.fn<typeof globalThis.fetch>(async () => Response.json({ ok: true }));
    await createFetch(transport)(request);
    expect(transport).toHaveBeenCalledWith(request, undefined);
    expect(request.bodyUsed).toBe(false);
    await request.body?.cancel();
  });

  it("supports a Request with an explicit replayable string override", async () => {
    const request = new Request(ENDPOINT, INIT);
    const captured: Request[] = [];
    const fetch = createFetch(async (input, init) => {
      captured.push(new Request(input, init));
      return new Response("fixture", { status: captured.length === 1 ? 415 : 200 });
    });
    await fetch(request, { body: BODY });
    expect(await Promise.all(captured.map(decode))).toEqual([BODY, BODY]);
    expect(captured.map((entry) => entry.headers.get("content-encoding"))).toEqual(["br", "gzip"]);
  });

  it.each(["application/json-seq", "text/application/json", "application/jsonp"])(
    "does not compress the non-JSON MIME %s",
    async (mime) => {
      const init = { ...INIT, headers: { "content-type": mime } };
      const transport = vi.fn<typeof globalThis.fetch>(async () => Response.json({ ok: true }));
      await createFetch(transport)(ENDPOINT, init);
      expect(transport).toHaveBeenCalledWith(ENDPOINT, init);
    },
  );

  it("compresses structured JSON MIME with parameters", async () => {
    let captured: Request | undefined;
    await createFetch(async (input, init) => {
      captured = new Request(input, init);
      return Response.json({ ok: true });
    })(ENDPOINT, {
      ...INIT,
      headers: { "content-type": "application/problem+json; charset=utf-8" },
    });
    expect(await decode(captured!)).toBe(BODY);
  });

  it("does no compression or transport work for an already cancelled request", async () => {
    const signal = AbortSignal.abort(new Error("fixture cancelled"));
    const debug = vi.fn();
    const transport = vi.fn<typeof globalThis.fetch>(async () => Response.json({ ok: true }));
    const fetch = createRequestCompressionFetch({
      fetch: transport,
      algorithm: "brotli",
      providerId: "fixture",
      logger: { debug, info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() },
    });
    await expect(fetch(ENDPOINT, { ...INIT, signal })).rejects.toBe(signal.reason);
    expect(debug).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it("stops waiting for compression after cancellation and sends no late bytes", async () => {
    const controller = new AbortController();
    const reason = new Error("fixture cancelled during compression");
    const transport = vi.fn<typeof globalThis.fetch>(async () => Response.json({ ok: true }));
    const pending = createFetch(transport)(ENDPOINT, { ...INIT, signal: controller.signal });
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(transport).not.toHaveBeenCalled();
  });

  it("does not retry or update memory when cancelled after a 415", async () => {
    const state = { brotliUnsupported: false };
    const controller = new AbortController();
    const reason = new Error("fixture cancelled after response");
    const transport = vi.fn<typeof globalThis.fetch>(async () => {
      controller.abort(reason);
      return new Response("unsupported", { status: 415 });
    });
    await expect(
      createFetch(transport, state)(ENDPOINT, { ...INIT, signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(state.brotliUnsupported).toBe(false);
  });

  it("checks cancellation again at the transport boundary", async () => {
    const controller = new AbortController();
    const reason = new Error("fixture cancelled after compression");
    const transport = vi.fn<typeof globalThis.fetch>(async () => new Response("ok"));
    const fetch = createRequestCompressionFetch({
      fetch: transport,
      algorithm: "brotli",
      providerId: "fixture",
      logger: {
        debug: () => controller.abort(reason),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        child: vi.fn(),
      },
    });
    await expect(fetch(ENDPOINT, { ...INIT, signal: controller.signal })).rejects.toBe(reason);
    expect(transport).not.toHaveBeenCalled();
  });
});
