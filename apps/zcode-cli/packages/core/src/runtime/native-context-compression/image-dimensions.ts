interface Dimensions {
  width: number;
  height: number;
}
/** 只读取编码 header，不解码或重编码精确 CUA 栅格与原图回取。 */
export function nativeImageDimensions(bytes: Uint8Array): Dimensions | undefined {
  if (bytes.byteLength < 10) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const valid = (width: number, height: number): Dimensions | undefined =>
    Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0
      ? { width, height }
      : undefined;
  const ascii = (offset: number, value: string) =>
    offset + value.length <= bytes.byteLength &&
    [...value].every((character, index) => bytes[offset + index] === character.charCodeAt(0));
  if (
    bytes.byteLength >= 24 &&
    bytes[0] === 137 &&
    ascii(1, "PNG\r\n\x1a\n") &&
    ascii(12, "IHDR")
  ) {
    return valid(view.getUint32(16), view.getUint32(20));
  }
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a"))
    return valid(view.getUint16(6, true), view.getUint16(8, true));
  if (ascii(0, "BM") && bytes.byteLength >= 26)
    return valid(view.getInt32(18, true), Math.abs(view.getInt32(22, true)));
  if (bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 4 <= bytes.byteLength) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker !== undefined && marker >= 208 && marker <= 215)) continue;
      if (offset + 2 > bytes.byteLength) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.byteLength) break;
      if (
        marker !== undefined &&
        marker >= 192 &&
        marker <= 207 &&
        ![196, 200, 204].includes(marker) &&
        length >= 7
      ) {
        return valid(view.getUint16(offset + 5), view.getUint16(offset + 3));
      }
      offset += length;
    }
  }
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) {
    let offset = 12;
    while (offset + 8 <= bytes.byteLength) {
      const size = view.getUint32(offset + 4, true),
        start = offset + 8;
      if (size > bytes.byteLength - start) break;
      if (ascii(offset, "VP8X") && size >= 10) {
        const width = 1 + bytes[start + 4]! + (bytes[start + 5]! << 8) + (bytes[start + 6]! << 16);
        const height = 1 + bytes[start + 7]! + (bytes[start + 8]! << 8) + (bytes[start + 9]! << 16);
        return valid(width, height);
      }
      if (ascii(offset, "VP8L") && size >= 5 && bytes[start] === 47) {
        const width = 1 + ((bytes[start + 1]! | (bytes[start + 2]! << 8)) & 16383);
        const height =
          1 +
          (((bytes[start + 2]! >> 6) | (bytes[start + 3]! << 2) | (bytes[start + 4]! << 10)) &
            16383);
        return valid(width, height);
      }
      if (
        ascii(offset, "VP8 ") &&
        size >= 10 &&
        bytes[start + 3] === 157 &&
        bytes[start + 4] === 1 &&
        bytes[start + 5] === 42
      ) {
        return valid(
          view.getUint16(start + 6, true) & 16383,
          view.getUint16(start + 8, true) & 16383,
        );
      }
      offset = start + size + (size & 1);
    }
  }
  return undefined;
}
