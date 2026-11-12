import { describe, expect, it } from "vitest";
import { createRecommendedNativeContextParameters } from "@zcode/shared/native-context-compression";
import { createJimpImageProcessorAdapter } from "../src/image/index.js";

function gif() {
  const header = "47494638396101000100800000000000ffffff";
  const loop = "21ff0b4e45545343415045322e300301000000";
  const frameA = "21f904000a0000002c0000000001000100000202440100";
  const frameB = "21f904000a0000002c00000000010001000002024c0100";
  return Buffer.from(header + loop + frameA + frameB + "3b", "hex");
}

function webpChunk(kind: string, payload: Buffer) {
  const header = Buffer.alloc(8);
  header.write(kind, "ascii");
  header.writeUInt32LE(payload.byteLength, 4);
  return Buffer.concat([header, payload, ...(payload.length & 1 ? [Buffer.alloc(1)] : [])]);
}

function webp() {
  const staticFrame = Buffer.from(
    "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA",
    "base64",
  );
  const frameHeader = Buffer.alloc(16);
  frameHeader.writeUIntLE(100, 12, 3);
  const frame = webpChunk("ANMF", Buffer.concat([frameHeader, staticFrame.subarray(12)]));
  const body = Buffer.concat([
    Buffer.from("WEBP", "ascii"),
    webpChunk("VP8X", Buffer.from([2, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
    webpChunk("ANIM", Buffer.alloc(6)),
    frame,
    frame,
  ]);
  const header = Buffer.alloc(8);
  header.write("RIFF", "ascii");
  header.writeUInt32LE(body.byteLength, 4);
  return Buffer.concat([header, body]);
}

function request(data: Buffer, mediaType: string) {
  return {
    data,
    mediaType,
    maxDimension: 2048,
    maxRawBytes: 1024 * 1024,
    maxBase64Bytes: 2 * 1024 * 1024,
    sourceKind: "attachment" as const,
    nativeContextPolicy: createRecommendedNativeContextParameters().images,
  };
}

describe("native image passthrough boundaries", () => {
  it.each([
    ["image/gif", gif()],
    ["image/webp", webp()],
  ] as const)("retains every animation byte for %s", async (mediaType, data) => {
    const result = await createJimpImageProcessorAdapter().prepareForModel(
      request(data, mediaType),
    );
    expect(Buffer.from(result.data)).toEqual(data);
    expect(result).toMatchObject({
      mediaType,
      strategy: "original",
      compressed: false,
      resized: false,
      width: 1,
      height: 1,
    });
    expect(result.quality).toBeUndefined();
  });

  it.each([
    ["image/gif", gif()],
    ["image/webp", webp()],
  ] as const)(
    "returns typed too_large for over-budget %s instead of decoding a frame",
    async (mediaType, data) => {
      await expect(
        createJimpImageProcessorAdapter().prepareForModel({
          ...request(data, mediaType),
          maxRawBytes: data.length - 1,
        }),
      ).rejects.toMatchObject({ code: "too_large" });
    },
  );

  it("checks known animation canvas dimensions against the hard limit", async () => {
    const data = gif();
    data.writeUInt16LE(3000, 6);
    await expect(
      createJimpImageProcessorAdapter().prepareForModel(request(data, "image/gif")),
    ).rejects.toMatchObject({ code: "too_large" });
    const webpData = webp();
    webpData.writeUIntLE(2999, 24, 3);
    await expect(
      createJimpImageProcessorAdapter().prepareForModel(request(webpData, "image/webp")),
    ).rejects.toMatchObject({ code: "too_large" });
  });

  it("preserves unsupported formats only while their original bytes fit the hard budget", async () => {
    const data = Buffer.from("synthetic unknown format");
    const result = await createJimpImageProcessorAdapter().prepareForModel(
      request(data, "image/unknown"),
    );
    expect(Buffer.from(result.data)).toEqual(data);
    expect(result.width).toBeUndefined();
    await expect(
      createJimpImageProcessorAdapter().prepareForModel({
        ...request(data, "image/unknown"),
        maxRawBytes: data.length - 1,
      }),
    ).rejects.toMatchObject({ code: "too_large" });
  });
});
