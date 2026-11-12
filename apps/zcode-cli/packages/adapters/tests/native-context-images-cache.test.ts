import { afterEach, describe, expect, it, vi } from "vitest";
import { Jimp, JimpMime, rgbaToInt } from "jimp";
import type { ImagePrepareForModelRequest } from "@zcode/contracts";
import { createRecommendedNativeContextParameters } from "@zcode/shared/native-context-compression";
import { createJimpImageProcessorAdapter } from "../src/image/index.js";

async function png(width = 512, height = 256, seed = 3) {
  const image = new Jimp({ width, height, color: 0x000000ff });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      image.setPixelColor(rgbaToInt(seed >>> 24, (seed >>> 16) & 255, seed & 255, 255), x, y);
    }
  }
  return image.getBuffer(JimpMime.png, { deflateLevel: 9, deflateStrategy: 3 });
}

function request(data: Buffer): ImagePrepareForModelRequest {
  return {
    data,
    maxDimension: 2048,
    maxRawBytes: 8 * 1024 * 1024,
    maxBase64Bytes: 12 * 1024 * 1024,
    mediaType: "image/png",
    sourceKind: "attachment",
    targetCapabilityKey: "fixture-model-a",
    nativeContextPolicy: {
      ...createRecommendedNativeContextParameters().images,
      maxEdge: 256,
      minEdge: 128,
      minReductionPercent: 0,
      cacheMaxEntries: 2,
      cacheMaxMiB: 1,
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("native image sending-copy cache", () => {
  it("reuses a completed copy without allowing callers to corrupt cached bytes", async () => {
    const input = await png();
    const original = Buffer.from(input);
    const encode = vi.spyOn(Jimp.prototype, "getBuffer");
    const adapter = createJimpImageProcessorAdapter();
    const first = await adapter.prepareForModel(request(input));
    const expected = Buffer.from(first.data);
    const calls = encode.mock.calls.length;
    first.data.fill(0);
    const second = await adapter.prepareForModel(request(input));
    expect(encode.mock.calls.length).toBe(calls);
    expect(Buffer.from(second.data)).toEqual(expected);
    second.data.fill(1);
    const third = await adapter.prepareForModel(request(input));
    expect(Buffer.from(third.data)).toEqual(expected);
    expect(input).toEqual(original);
    expect(third.originalArtifactUri).toBeUndefined();
    expect(third.originalSha256).toBeUndefined();
  });

  it("isolates adapter instances and all policy, capability, and hard-budget dimensions", async () => {
    const input = await png();
    const encode = vi.spyOn(Jimp.prototype, "getBuffer");
    const adapter = createJimpImageProcessorAdapter();
    const base = request(input);
    await adapter.prepareForModel(base);
    let calls = encode.mock.calls.length;
    const changes: ImagePrepareForModelRequest[] = [
      { ...base, nativeContextPolicy: { ...base.nativeContextPolicy!, omitSeen: true } },
      { ...base, maxRawBytes: base.maxRawBytes - 1 },
      { ...base, maxBase64Bytes: base.maxBase64Bytes - 4 },
      { ...base, maxDimension: base.maxDimension - 1 },
      { ...base, maxTokens: 1_000_000, tokenToBase64CharRatio: 0.2 },
      { ...base, targetCapabilityKey: "fixture-model-b" },
      { ...base, sourceKind: "read" },
    ];
    for (const changed of changes) {
      await adapter.prepareForModel(changed);
      expect(encode.mock.calls.length).toBeGreaterThan(calls);
      calls = encode.mock.calls.length;
    }
    await createJimpImageProcessorAdapter().prepareForModel(changes.at(-1)!);
    expect(encode.mock.calls.length).toBeGreaterThan(calls);
  });

  it("evicts the least recently used copy by entry count", async () => {
    const sources = await Promise.all([png(512, 256, 1), png(512, 256, 2), png(512, 256, 3)]);
    const encode = vi.spyOn(Jimp.prototype, "getBuffer");
    const adapter = createJimpImageProcessorAdapter();
    const requests = sources.map(request);
    await adapter.prepareForModel(requests[0]!);
    await adapter.prepareForModel(requests[1]!);
    await adapter.prepareForModel(requests[0]!);
    await adapter.prepareForModel(requests[2]!);
    const calls = encode.mock.calls.length;
    await adapter.prepareForModel(requests[0]!);
    expect(encode.mock.calls.length).toBe(calls);
    await adapter.prepareForModel(requests[1]!);
    expect(encode.mock.calls.length).toBeGreaterThan(calls);
  });

  it("enforces the byte cap independently of the entry cap", async () => {
    const sources = await Promise.all([png(1024, 512, 1), png(1024, 512, 2)]);
    const encode = vi.spyOn(Jimp.prototype, "getBuffer");
    const adapter = createJimpImageProcessorAdapter();
    const requests = sources.map((data) => {
      const value = request(data);
      value.nativeContextPolicy = {
        ...value.nativeContextPolicy!,
        maxEdge: 768,
        cacheMaxEntries: 100,
      };
      return value;
    });
    const first = await adapter.prepareForModel(requests[0]!);
    const second = await adapter.prepareForModel(requests[1]!);
    expect(first.data.byteLength + second.data.byteLength).toBeGreaterThan(1024 * 1024);
    const calls = encode.mock.calls.length;
    await adapter.prepareForModel(requests[0]!);
    expect(encode.mock.calls.length).toBeGreaterThan(calls);
  });

  it.each(["cacheMaxEntries", "cacheMaxMiB"] as const)(
    "clears and disables copies when %s is zero",
    async (field) => {
      const input = await png();
      const encode = vi.spyOn(Jimp.prototype, "getBuffer");
      const adapter = createJimpImageProcessorAdapter();
      const base = request(input);
      await adapter.prepareForModel(base);
      const disabled = {
        ...base,
        nativeContextPolicy: { ...base.nativeContextPolicy!, [field]: 0 },
      };
      await adapter.prepareForModel(disabled);
      let calls = encode.mock.calls.length;
      await adapter.prepareForModel(disabled);
      expect(encode.mock.calls.length).toBeGreaterThan(calls);
      calls = encode.mock.calls.length;
      await adapter.prepareForModel(base);
      expect(encode.mock.calls.length).toBeGreaterThan(calls);
    },
  );

  it("checks cancellation before returning a cached copy", async () => {
    const input = await png();
    const adapter = createJimpImageProcessorAdapter();
    await adapter.prepareForModel(request(input));
    const controller = new AbortController();
    controller.abort();
    await expect(
      adapter.prepareForModel(request(input), { signal: controller.signal }),
    ).rejects.toThrow("cancelled");
  });
});
