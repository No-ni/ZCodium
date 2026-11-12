export interface NativeImageFormat {
  mediaType: string;
  passthrough: boolean;
  width?: number;
  height?: number;
}

export function normalizeNativeImageMediaType(value: string): string {
  const mediaType = value.toLowerCase();
  if (mediaType === "image/jpg") return "image/jpeg";
  if (mediaType === "image/x-ms-bmp" || mediaType === "image/x-bmp") return "image/bmp";
  return mediaType;
}

export function inspectNativeImageFormat(input: Buffer, declared: string): NativeImageFormat {
  let mediaType = normalizeNativeImageMediaType(declared);
  if (
    input.length >= 8 &&
    input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    mediaType = "image/png";
  } else if (input.length >= 3 && input[0] === 255 && input[1] === 216 && input[2] === 255) {
    mediaType = "image/jpeg";
  } else if (input.length >= 2 && input[0] === 66 && input[1] === 77) {
    mediaType = "image/bmp";
  } else if (input.length >= 6 && ["GIF87a", "GIF89a"].includes(input.toString("ascii", 0, 6))) {
    mediaType = "image/gif";
  } else if (
    input.length >= 12 &&
    input.toString("ascii", 0, 4) === "RIFF" &&
    input.toString("ascii", 8, 12) === "WEBP"
  ) {
    mediaType = "image/webp";
  }

  if (mediaType === "image/gif") {
    const dimensions =
      input.length >= 10 ? checkedDimensions(input.readUInt16LE(6), input.readUInt16LE(8)) : {};
    return { mediaType, passthrough: true, ...dimensions };
  }
  if (mediaType === "image/webp") {
    return { mediaType, passthrough: true, ...webpDimensions(input) };
  }
  if (mediaType === "image/png" && isAnimatedPng(input)) {
    return {
      mediaType,
      passthrough: true,
      ...checkedDimensions(input.readUInt32BE(16), input.readUInt32BE(20)),
    };
  }
  return { mediaType, passthrough: !["image/png", "image/jpeg", "image/bmp"].includes(mediaType) };
}

function webpDimensions(input: Buffer): { width?: number; height?: number } {
  if (
    input.length < 20 ||
    input.toString("ascii", 0, 4) !== "RIFF" ||
    input.toString("ascii", 8, 12) !== "WEBP"
  )
    return {};
  for (let offset = 12; offset + 8 <= input.length; ) {
    const kind = input.toString("ascii", offset, offset + 4);
    const size = input.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (size > input.length - body) return {};
    if (kind === "VP8X" && size >= 10) {
      return checkedDimensions(
        1 + input.readUIntLE(body + 4, 3),
        1 + input.readUIntLE(body + 7, 3),
      );
    }
    if (kind === "VP8L" && size >= 5 && input[body] === 0x2f) {
      const bits = input.readUInt32LE(body + 1);
      return checkedDimensions(1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff));
    }
    if (
      kind === "VP8 " &&
      size >= 10 &&
      input[body + 3] === 0x9d &&
      input[body + 4] === 0x01 &&
      input[body + 5] === 0x2a
    ) {
      return checkedDimensions(
        input.readUInt16LE(body + 6) & 0x3fff,
        input.readUInt16LE(body + 8) & 0x3fff,
      );
    }
    offset = body + size + (size & 1);
  }
  return {};
}

function isAnimatedPng(input: Buffer): boolean {
  if (input.length < 24 || input.toString("ascii", 12, 16) !== "IHDR") return false;
  for (let offset = 8; offset + 12 <= input.length; ) {
    const size = input.readUInt32BE(offset);
    if (size > input.length - offset - 12) return false;
    const kind = input.toString("ascii", offset + 4, offset + 8);
    if (kind === "acTL") return true;
    if (kind === "IEND") return false;
    offset += size + 12;
  }
  return false;
}

function checkedDimensions(width: number, height: number): { width?: number; height?: number } {
  return width > 0 && height > 0 ? { width, height } : {};
}
