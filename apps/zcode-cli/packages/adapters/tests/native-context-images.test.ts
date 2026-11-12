import { describe, expect, it } from "vitest";
import { Jimp, JimpMime, rgbaToInt } from "jimp";
import type { ImagePrepareForModelRequest } from "@zcode/contracts";
import {
  createRecommendedNativeContextParameters,
  type NativeContextParameters,
} from "@zcode/shared/native-context-compression";
import { createJimpImageProcessorAdapter } from "../src/image/index.js";

type Images = NativeContextParameters["images"];

function policy(overrides: Partial<Images> = {}): Images {
  return {
    ...createRecommendedNativeContextParameters().images,
    maxEdge: 256,
    minEdge: 128,
    minReductionPercent: 0,
    cacheMaxEntries: 0,
    cacheMaxMiB: 0,
    ...overrides,
  };
}

function request(
  data: Buffer,
  images: Images = policy(),
  overrides: Partial<ImagePrepareForModelRequest> = {},
): ImagePrepareForModelRequest {
  return {
    data,
    maxBase64Bytes: 12 * 1024 * 1024,
    maxDimension: 2048,
    maxRawBytes: 8 * 1024 * 1024,
    mediaType: "image/png",
    nativeContextPolicy: images,
    sourceKind: "attachment",
    ...overrides,
  };
}

function noisyImage(width: number, height: number, alpha = 255) {
  const image = new Jimp({ width, height, color: 0x000000ff });
  let seed = 0x5d3b;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      image.setPixelColor(rgbaToInt(seed >>> 24, (seed >>> 16) & 255, seed & 255, alpha), x, y);
    }
  }
  return image;
}

async function png(width: number, height: number, alpha = 255) {
  return noisyImage(width, height, alpha).getBuffer(JimpMime.png, {
    deflateLevel: 9,
    deflateStrategy: 3,
  });
}

describe("native image compression policies", () => {
  it("keeps small original bytes for edge gate even when the byte gate is zero", async () => {
    const input = await png(192, 192);
    const before = Buffer.from(input);
    const result = await createJimpImageProcessorAdapter().prepareForModel(
      request(input, policy({ triggerMode: "edge", byteTriggerKiB: 0 })),
    );
    expect(Buffer.from(result.data)).toEqual(before);
    expect(input).toEqual(before);
    expect(result).toMatchObject({ strategy: "original", compressed: false, resized: false });
    expect(result.quality).toBeUndefined();
  });

  it("only shrinks the sending copy and reports its actual dimensions", async () => {
    const input = await png(512, 256);
    const before = Buffer.from(input);
    const result = await createJimpImageProcessorAdapter().prepareForModel(request(input));
    const decoded = await Jimp.read(Buffer.from(result.data));
    expect(input).toEqual(before);
    expect(result).toMatchObject({
      originalWidth: 512,
      originalHeight: 256,
      width: 256,
      height: 128,
    });
    expect(decoded.bitmap.width).toBe(result.width);
    expect(decoded.bitmap.height).toBe(result.height);
    expect(result.transformedSizeBytes).toBe(result.data.byteLength);
    expect(result.transformedSizeBytes).toBeLessThan(input.byteLength);
  });

  it.each([
    ["disabled", policy({ rescale: false }), "attachment"],
    ["excluded source", policy({ sourceKinds: [] }), "attachment"],
    ["unknown source", policy(), undefined],
  ] as const)(
    "keeps original bytes when performance processing has %s",
    async (_name, images, sourceKind) => {
      const input = await png(512, 256);
      const result = await createJimpImageProcessorAdapter().prepareForModel(
        request(input, images, { sourceKind }),
      );
      expect(Buffer.from(result.data)).toEqual(input);
      expect(result.compressed).toBe(false);
    },
  );

  it("can re-encode an opaque PNG at the same dimensions with edge-or-bytes", async () => {
    const input = await png(192, 192);
    const result = await createJimpImageProcessorAdapter().prepareForModel(
      request(
        input,
        policy({
          triggerMode: "edge-or-bytes",
          byteTriggerKiB: 0,
          pngMode: "jpeg-if-opaque",
          jpegQuality: 83,
          minJpegQuality: 83,
          minEdge: 192,
        }),
      ),
    );
    expect(result).toMatchObject({
      mediaType: "image/jpeg",
      width: 192,
      height: 192,
      resized: false,
      quality: 83,
    });
    expect(result.transformedSizeBytes).toBeLessThan(input.byteLength);
  });

  it("preserves transparency instead of converting a transparent PNG to JPEG", async () => {
    const input = await png(512, 256, 96);
    const result = await createJimpImageProcessorAdapter().prepareForModel(
      request(input, policy({ pngMode: "jpeg-if-opaque", alphaMode: "preserve" })),
    );
    const decoded = await Jimp.read(Buffer.from(result.data));
    expect(result.mediaType).toBe("image/png");
    expect(decoded.bitmap.data[3]).toBeLessThan(255);
    expect(result.quality).toBeUndefined();
  });

  it("flattens alpha against the configured fixed background", async () => {
    const image = noisyImage(512, 256, 128);
    for (let y = 0; y < 32; y += 1) {
      for (let x = 0; x < 32; x += 1) image.setPixelColor(rgbaToInt(255, 0, 0, 128), x, y);
    }
    const input = await image.getBuffer(JimpMime.png);
    const result = await createJimpImageProcessorAdapter().prepareForModel(
      request(
        input,
        policy({ alphaMode: "flatten", flattenColor: "#00ff00", pngMode: "preserve" }),
      ),
    );
    const decoded = await Jimp.read(Buffer.from(result.data));
    const offset = (2 * decoded.bitmap.width + 2) * 4;
    expect([...decoded.bitmap.data.subarray(offset, offset + 4)]).toEqual([128, 127, 0, 255]);
    expect(image.bitmap.data[3]).toBe(128);
  });

  it("uses the selected JPEG quality immediately instead of the old fixed quality chain", async () => {
    const input = await noisyImage(384, 192).getBuffer(JimpMime.jpeg, { quality: 99 });
    const result = await createJimpImageProcessorAdapter().prepareForModel(
      request(input, policy({ maxEdge: 192, minEdge: 192, jpegQuality: 91, minJpegQuality: 91 }), {
        mediaType: "image/jpeg",
      }),
    );
    expect(result).toMatchObject({ mediaType: "image/jpeg", quality: 91, width: 192, height: 96 });
  });

  it("can enforce existing hard budgets with rescale disabled without crossing the minimum edge", async () => {
    const image = noisyImage(384, 256);
    const input = await image.getBuffer(JimpMime.png);
    // 不同插值方式的 PNG 字节不等价；预算独立于实现，只要求受硬限制缩小且不跨下限。
    const hardBudget = Math.floor(input.byteLength / 3);
    const result = await createJimpImageProcessorAdapter().prepareForModel(
      request(input, policy({ rescale: false }), { maxRawBytes: hardBudget }),
    );
    expect(result.transformedSizeBytes).toBeLessThanOrEqual(hardBudget);
    expect(Math.max(result.width!, result.height!)).toBeGreaterThanOrEqual(128);
    expect(Math.max(result.width!, result.height!)).toBeLessThanOrEqual(384);
  });

  it("returns typed too_large when the quality and edge floors cannot satisfy the hard budget", async () => {
    const image = noisyImage(128, 128);
    const input = await image.getBuffer(JimpMime.png);
    const forbiddenQuality = await image.getBuffer(JimpMime.jpeg, { quality: 20 });
    const allowedQuality = await image.getBuffer(JimpMime.jpeg, { quality: 73 });
    const hardBudget = forbiddenQuality.byteLength + 1;
    expect(allowedQuality.byteLength).toBeGreaterThan(hardBudget);
    await expect(
      createJimpImageProcessorAdapter().prepareForModel(
        request(input, policy({ jpegQuality: 73, minJpegQuality: 73, pngMode: "jpeg-if-opaque" }), {
          maxRawBytes: hardBudget,
        }),
      ),
    ).rejects.toMatchObject({ code: "too_large" });
  });

  it("does not cross minEdge to satisfy a smaller hard dimension", async () => {
    const input = await png(256, 256);
    await expect(
      createJimpImageProcessorAdapter().prepareForModel(
        request(input, policy(), { maxDimension: 64 }),
      ),
    ).rejects.toMatchObject({ code: "too_large" });
  });

  it("rejects copies below the requested reduction percentage even if they fit", async () => {
    const input = await png(512, 512);
    const result = await createJimpImageProcessorAdapter().prepareForModel(
      request(input, policy({ minEdge: 256, minReductionPercent: 99 })),
    );
    expect(Buffer.from(result.data)).toEqual(input);
    expect(result.compressed).toBe(false);
  });

  it("requires a strict byte reduction even when the reduction threshold is zero", async () => {
    const input = await noisyImage(128, 128).getBuffer(JimpMime.jpeg, { quality: 20 });
    const result = await createJimpImageProcessorAdapter().prepareForModel(
      request(
        input,
        policy({
          triggerMode: "edge-or-bytes",
          byteTriggerKiB: 0,
          jpegQuality: 100,
          minJpegQuality: 100,
        }),
        { mediaType: "image/jpeg" },
      ),
    );
    expect(Buffer.from(result.data)).toEqual(input);
    expect(result.compressed).toBe(false);
  });

  it("honors an explicit sending target within the hard budget", async () => {
    const input = await png(512, 512);
    const result = await createJimpImageProcessorAdapter().prepareForModel(
      request(input, policy({ targetRawKiB: 16, pngMode: "jpeg-if-opaque" })),
    );
    expect(result.transformedSizeBytes).toBeLessThanOrEqual(16 * 1024);
    expect(result.quality).toBeGreaterThanOrEqual(60);
    expect(Math.max(result.width!, result.height!)).toBeGreaterThanOrEqual(128);
  });

  it("retains a legal beneficial copy at the floor when only the soft target remains unmet", async () => {
    const input = await png(128, 128);
    const result = await createJimpImageProcessorAdapter().prepareForModel(
      request(
        input,
        policy({
          targetRawKiB: 16,
          pngMode: "jpeg-if-opaque",
          triggerMode: "edge-or-bytes",
          byteTriggerKiB: 0,
          jpegQuality: 90,
          minJpegQuality: 90,
        }),
      ),
    );
    expect(result.transformedSizeBytes).toBeGreaterThan(16 * 1024);
    expect(result.transformedSizeBytes).toBeLessThan(input.byteLength);
    expect(result).toMatchObject({ quality: 90, width: 128, height: 128, compressed: true });
  });

  it("satisfies base64 and token caps as well as raw bytes", async () => {
    const input = await png(512, 512);
    const result = await createJimpImageProcessorAdapter().prepareForModel(
      request(input, policy({ pngMode: "jpeg-if-opaque" }), {
        maxBase64Bytes: 30_000,
        maxTokens: 2000,
        tokenToBase64CharRatio: 0.2,
      }),
    );
    const base64Length = Math.ceil(result.data.byteLength / 3) * 4;
    expect(base64Length).toBeLessThanOrEqual(30_000);
    expect(Math.ceil(base64Length * 0.2)).toBeLessThanOrEqual(2000);
  });

  it("decodes BMP reliably and never labels original BMP bytes as PNG", async () => {
    const input = await noisyImage(512, 256).getBuffer(JimpMime.bmp);
    const result = await createJimpImageProcessorAdapter().prepareForModel(
      request(input, policy(), { mediaType: "image/bmp" }),
    );
    const decoded = await Jimp.read(Buffer.from(result.data));
    expect(result.mediaType).toBe("image/png");
    expect(decoded.bitmap.width).toBe(256);
    const original = await createJimpImageProcessorAdapter().prepareForModel(
      request(input, policy({ rescale: false }), { mediaType: "image/bmp" }),
    );
    expect(original.mediaType).toBe("image/bmp");
    expect(Buffer.from(original.data)).toEqual(input);
  });

  it.each([
    { maxTokens: Number.NaN },
    { maxTokens: Number.POSITIVE_INFINITY },
    { tokenToBase64CharRatio: 0 },
    { tokenToBase64CharRatio: Number.NaN },
  ])("rejects an invalid budget %j", async (overrides) => {
    const input = await png(128, 128);
    await expect(
      createJimpImageProcessorAdapter().prepareForModel(request(input, policy(), overrides)),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("uses strict shared policy validation and rejects a target above the effective hard budget", async () => {
    const input = await png(128, 128);
    await expect(
      createJimpImageProcessorAdapter().prepareForModel(
        request(input, policy({ jpegQuality: 60, minJpegQuality: 61 })),
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      createJimpImageProcessorAdapter().prepareForModel(
        request(input, { ...policy(), unknownField: true } as Images),
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      createJimpImageProcessorAdapter().prepareForModel(
        request(input, policy({ targetRawKiB: 16 }), { maxBase64Bytes: 1000 }),
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("does not decode invalid PNG data or process an already cancelled request", async () => {
    await expect(
      createJimpImageProcessorAdapter().prepareForModel(request(Buffer.from("invalid"))),
    ).rejects.toMatchObject({ code: "processing_failed" });
    const controller = new AbortController();
    controller.abort();
    await expect(
      createJimpImageProcessorAdapter().prepareForModel(request(await png(128, 128)), {
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled");
  });
});
