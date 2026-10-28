import {
  FILE_CHUNK_BYTES,
  MAX_BUNDLE_BYTES,
  OfficeError,
  isOfficeAssetName,
} from "#office/contract.ts";

const MAX_SCRIPT_PARTS = Math.ceil(MAX_BUNDLE_BYTES / FILE_CHUNK_BYTES) + 1;
const MAX_FONT_FACES = 256;
export const MAX_FALLBACK_FONT_BYTES = 32 * 1024 * 1024;
const FONT_NAME = /^fonts\/noto-sans-sc-\d+-400-normal\.woff2$/;
const UNICODE_RANGE =
  /^U\+[\da-f]{1,6}(?:-[\da-f]{1,6})?(?:\s*,\s*U\+[\da-f]{1,6}(?:-[\da-f]{1,6})?)*$/i;

const invalid = (): never => {
  throw new OfficeError("invalid_resource", "Invalid local viewer resource manifest.");
};
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : invalid();

/** 清单与字体来源都来自编译资产，仍须校验；不让资源结果变成任意 URL 或越界读取入口。 */
export function localAssetName(value: string): string {
  return isOfficeAssetName(value) ? value : invalid();
}

export function parseAssetManifest(value: unknown): { scripts: string[]; scriptBytes: number } {
  const { scripts, scriptBytes } = record(value);
  if (
    !Array.isArray(scripts) ||
    !scripts.length ||
    scripts.length > MAX_SCRIPT_PARTS ||
    !Number.isSafeInteger(scriptBytes) ||
    Number(scriptBytes) < 1 ||
    Number(scriptBytes) > MAX_BUNDLE_BYTES ||
    scripts.some((name, index) => name !== `bundle-${index}.txt`)
  )
    return invalid();
  return { scripts: scripts as string[], scriptBytes: Number(scriptBytes) };
}

export function verifyScriptParts(parts: readonly string[], scriptBytes: number): void {
  const encoder = new TextEncoder();
  let total = 0;
  for (const part of parts) {
    const bytes = encoder.encode(part).byteLength;
    if (!bytes || bytes > FILE_CHUNK_BYTES) invalid();
    total += bytes;
    if (total > MAX_BUNDLE_BYTES) invalid();
  }
  if (total !== scriptBytes) invalid();
}

function validRange(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 16_384 || !UNICODE_RANGE.test(value))
    return false;
  return value.split(",").every((range) => {
    const [start, end = start] = range
      .trim()
      .slice(2)
      .split("-")
      .map((hex) => Number.parseInt(hex, 16));
    return start <= end && end <= 0x10ffff;
  });
}

export function parseFontManifest(value: unknown): {
  faces: { file: string; unicodeRange: string }[];
} {
  const { faces } = record(value);
  if (!Array.isArray(faces) || !faces.length || faces.length > MAX_FONT_FACES) return invalid();
  const seen = new Set<string>();
  const parsed = faces.map((face) => {
    const { file, unicodeRange } = record(face);
    if (
      typeof file !== "string" ||
      !FONT_NAME.test(file) ||
      seen.has(file) ||
      !validRange(unicodeRange)
    )
      return invalid();
    seen.add(file);
    return { file: localAssetName(file), unicodeRange };
  });
  return { faces: parsed };
}
