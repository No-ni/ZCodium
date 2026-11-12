import type { AttachmentStorageMetadata } from "@zcode/contracts";
import type { OriginalImageProvenance } from "./contract.js";

export function originalImageToStorageMetadata(
  original: OriginalImageProvenance | undefined,
): AttachmentStorageMetadata["image"] {
  if (!original) return undefined;
  return {
    originalArtifactUri: original.artifactUri,
    originalSha256: original.sha256,
    originalBytes: original.bytes,
    originalMediaType: original.mediaType,
    sourceKind: original.sourceKind === "browser" ? "mcp" : original.sourceKind,
    ...(original.width !== undefined ? { originalWidth: original.width } : {}),
    ...(original.height !== undefined ? { originalHeight: original.height } : {}),
    ...(original.preserveRaster !== undefined ? { preserveRaster: original.preserveRaster } : {}),
  };
}

export function originalImageFromStorageMetadata(
  image: AttachmentStorageMetadata["image"],
): OriginalImageProvenance | undefined {
  if (
    !image?.originalArtifactUri?.startsWith("zcode-artifact://") ||
    !image.originalSha256 ||
    !/^[a-f0-9]{64}$/i.test(image.originalSha256) ||
    !Number.isSafeInteger(image.originalBytes) ||
    (image.originalBytes ?? 0) <= 0 ||
    !image.originalMediaType?.startsWith("image/") ||
    !image.sourceKind
  )
    return undefined;
  const sourceKind = image.sourceKind === "browser" ? "mcp" : image.sourceKind;
  if (!["attachment", "read", "bash", "mcp", "other"].includes(sourceKind)) return undefined;
  return {
    artifactUri: image.originalArtifactUri,
    sha256: image.originalSha256,
    bytes: image.originalBytes!,
    mediaType: image.originalMediaType,
    sourceKind,
    ...(validDimension(image.originalWidth) ? { width: image.originalWidth } : {}),
    ...(validDimension(image.originalHeight) ? { height: image.originalHeight } : {}),
    ...(typeof image.preserveRaster === "boolean" ? { preserveRaster: image.preserveRaster } : {}),
  };
}

function validDimension(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0;
}

// Symbol 只存在于 host 创建的对象中，第三方 JSON/metadata 无法签发原图证明。
const hostOriginalImage = Symbol("host-original-image-provenance");

export function withHostOriginalImageProvenance<T extends object>(
  value: T,
  original: OriginalImageProvenance,
): T {
  return Object.defineProperty({ ...value }, hostOriginalImage, {
    value: Object.freeze({ ...original }),
    enumerable: false,
  });
}

export function getHostOriginalImageProvenance(
  value: unknown,
): OriginalImageProvenance | undefined {
  if (!value || typeof value !== "object") return undefined;
  return (value as { [hostOriginalImage]?: OriginalImageProvenance })[hostOriginalImage];
}
