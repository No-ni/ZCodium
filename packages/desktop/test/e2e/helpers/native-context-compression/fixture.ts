import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";

export interface NativeContextPngFixture {
  bytes: Buffer;
  base64: string;
  sha256: string;
  width: number;
  height: number;
  alpha: boolean;
}

/** 真实、可重复解码的合成 PNG；不下载素材，也不把原图片写到系统临时目录。 */
export function createNativeContextPngFixture(
  width = 640,
  height = 400,
  alpha = false,
): NativeContextPngFixture {
  const pixels = Buffer.alloc((width * 4 + 1) * height);
  let seed = 0x5d3b;
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    for (let x = 0; x < width; x += 1) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const offset = row + x * 4 + 1;
      pixels[offset] = seed >>> 24;
      pixels[offset + 1] = (seed >>> 16) & 255;
      pixels[offset + 2] = seed & 255;
      pixels[offset + 3] = alpha && x < width / 2 ? 0 : 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const bytes = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  return {
    bytes,
    base64: bytes.toString("base64"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    width,
    height,
    alpha,
  };
}

export function readNativePngDimensions(bytes: Buffer) {
  if (
    bytes.length < 33 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    throw new Error("NCTX expected a real PNG sending copy");
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    alphaChannel: bytes[25] === 6 || bytes[25] === 4,
  };
}

/** 解码 PNG scanline 的真实 alpha，不能只把“有 alpha 通道”当作透明度仍存在的证明。 */
export function nativePngHasTransparentPixel(bytes: Buffer): boolean {
  const { width, height } = readNativePngDimensions(bytes);
  if (bytes[24] !== 8 || bytes[25] !== 6)
    throw new Error("NCTX transparency fixture requires 8-bit RGBA PNG");
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < bytes.length; ) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (offset + length + 12 > bytes.length) throw new Error("NCTX truncated PNG");
    if (type === "IDAT") chunks.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const rows = inflateSync(Buffer.concat(chunks));
  const stride = width * 4;
  if (rows.length !== height * (stride + 1)) throw new Error("NCTX invalid PNG scanline size");
  let previous = Buffer.alloc(stride);
  let found = false;
  for (let y = 0; y < height; y += 1) {
    const filter = rows[y * (stride + 1)]!;
    if (filter > 4) throw new Error("NCTX unsupported PNG row filter");
    const row = Buffer.alloc(stride);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= 4 ? row[x - 4]! : 0;
      const up = previous[x]!;
      const upperLeft = x >= 4 ? previous[x - 4]! : 0;
      const predictor = [0, left, up, Math.floor((left + up) / 2), paeth(left, up, upperLeft)][
        filter
      ]!;
      row[x] = (rows[y * (stride + 1) + x + 1]! + predictor) & 255;
      if (x % 4 === 3 && row[x] !== 255) found = true;
    }
    previous = row;
  }
  return found;
}

function paeth(left: number, up: number, upperLeft: number): number {
  const prediction = left + up - upperLeft;
  const distances = [
    Math.abs(prediction - left),
    Math.abs(prediction - up),
    Math.abs(prediction - upperLeft),
  ];
  return distances[0]! <= distances[1]! && distances[0]! <= distances[2]!
    ? left
    : distances[1]! <= distances[2]!
      ? up
      : upperLeft;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, "ascii");
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  name.copy(result, 4);
  data.copy(result, 8);
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([name, data])) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, data.length + 8);
  return result;
}
