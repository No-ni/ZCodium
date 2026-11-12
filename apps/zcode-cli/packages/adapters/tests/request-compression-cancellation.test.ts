import type { BrotliOptions, CompressCallback } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequestCompressionFetch } from "../src/model/request-compression/index.js";

const gate = vi.hoisted(() => ({
  algorithm: "brotli" as "brotli" | "gzip",
  callback: undefined as CompressCallback | undefined,
  started: undefined as (() => void) | undefined,
}));

vi.mock("node:zlib", async (importOriginal) => {
  const zlib = await importOriginal<typeof import("node:zlib")>();
  return {
    ...zlib,
    brotliCompress(source: Uint8Array, options: BrotliOptions, callback: CompressCallback) {
      if (gate.algorithm !== "brotli") return zlib.brotliCompress(source, options, callback);
      gate.callback = callback;
      gate.started?.();
    },
    gzip(source: Uint8Array, callback: CompressCallback) {
      if (gate.algorithm !== "gzip") return zlib.gzip(source, callback);
      gate.callback = callback;
      gate.started?.();
    },
  };
});

const INIT = {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ messages: [{ role: "user", content: "E2E_CANCEL_COMPRESSION" }] }),
};

afterEach(() => {
  gate.callback = undefined;
  gate.started = undefined;
});

describe("late native compression completion after cancellation", () => {
  it.each(["success", "failure"])(
    "discards a native Brotli %s after the caller stopped waiting",
    async (completion) => {
      gate.algorithm = "brotli";
      const started = new Promise<void>((resolve) => {
        gate.started = resolve;
      });
      const controller = new AbortController();
      const reason = new Error("fixture cancelled during native compression");
      const transport = vi.fn<typeof globalThis.fetch>(async () => new Response("ok"));
      const fetch = createRequestCompressionFetch({
        fetch: transport,
        providerId: "fixture",
        algorithm: "brotli",
      });
      const pending = fetch("https://fixture.invalid/v1/messages", {
        ...INIT,
        signal: controller.signal,
      });
      await started;
      controller.abort(reason);
      await expect(pending).rejects.toBe(reason);
      gate.callback!(
        completion === "failure" ? new Error("fixture late native failure") : null,
        Buffer.from("late bytes"),
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(transport).not.toHaveBeenCalled();
    },
  );

  it("sends no gzip retry or downgrade memory after cancelling its native compression", async () => {
    gate.algorithm = "gzip";
    const started = new Promise<void>((resolve) => {
      gate.started = resolve;
    });
    const controller = new AbortController();
    const state = { brotliUnsupported: false };
    const transport = vi.fn<typeof globalThis.fetch>(
      async () => new Response("unsupported", { status: 415 }),
    );
    const fetch = createRequestCompressionFetch({
      fetch: transport,
      providerId: "fixture",
      algorithm: "brotli",
      state,
    });
    const pending = fetch("https://fixture.invalid/v1/messages", {
      ...INIT,
      signal: controller.signal,
    });
    await started;
    controller.abort();
    await expect(pending).rejects.toBe(controller.signal.reason);
    gate.callback!(null, Buffer.from("late gzip bytes"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(transport).toHaveBeenCalledTimes(1);
    expect(state.brotliUnsupported).toBe(false);
  });
});
