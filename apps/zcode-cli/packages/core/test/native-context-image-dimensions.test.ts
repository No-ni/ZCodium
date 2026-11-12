import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeImageDimensions } from "../src/runtime/native-context-compression/image-dimensions.js";
import { pngHeaderBytes } from "./native-context-image-fixture.js";

test("PNG and animated GIF headers report actual dimensions without decoding a frame", () => {
  assert.deepEqual(nativeImageDimensions(pngHeaderBytes(24, 4096, 128)), {
    width: 4096,
    height: 128,
  });
  const gif = Buffer.alloc(16);
  gif.write("GIF89a");
  gif.writeUInt16LE(640, 6);
  gif.writeUInt16LE(480, 8);
  assert.deepEqual(nativeImageDimensions(gif), { width: 640, height: 480 });
});
test("JPEG SOF skips earlier metadata and BMP accepts top-down raster height", () => {
  const jpeg = Buffer.from([255, 216, 255, 224, 0, 4, 0, 0, 255, 192, 0, 7, 8, 1, 224, 2, 128]);
  assert.deepEqual(nativeImageDimensions(jpeg), { width: 640, height: 480 });
  const bmp = Buffer.alloc(26);
  bmp.write("BM");
  bmp.writeInt32LE(640, 18);
  bmp.writeInt32LE(-480, 22);
  assert.deepEqual(nativeImageDimensions(bmp), { width: 640, height: 480 });
});
test("WebP extended canvas reports animation dimensions without truncating frames", () => {
  const webp = Buffer.alloc(30);
  webp.write("RIFF");
  webp.write("WEBP", 8);
  webp.write("VP8X", 12);
  webp.writeUInt32LE(10, 16);
  webp[20] = 2;
  webp.writeUIntLE(639, 24, 3);
  webp.writeUIntLE(479, 27, 3);
  assert.deepEqual(nativeImageDimensions(webp), { width: 640, height: 480 });
});
test("truncated or zero-sized headers fail closed instead of reading beyond the buffer", () => {
  assert.equal(nativeImageDimensions(Buffer.alloc(2)), undefined);
  assert.equal(nativeImageDimensions(pngHeaderBytes(24, 0, 1)), undefined);
  assert.equal(
    nativeImageDimensions(Buffer.from([255, 216, 255, 224, 255, 255, 0, 0, 0, 0])),
    undefined,
  );
  const webp = Buffer.alloc(20);
  webp.write("RIFF");
  webp.write("WEBP", 8);
  webp.write("VP8X", 12);
  webp.writeUInt32LE(100, 16);
  assert.equal(nativeImageDimensions(webp), undefined);
});
