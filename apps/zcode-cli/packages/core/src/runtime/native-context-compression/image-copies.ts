import {
  createImageProcessorError,
  parseImageDataUrl,
  READ_IMAGE_MAX_BASE64_BYTES,
  READ_IMAGE_MAX_DIMENSION,
  READ_IMAGE_TARGET_BYTES,
} from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import { nativeHash } from "./identity.js";
import { NativeContextRuntimeError } from "./contract.js";
import { nativeImageDimensions } from "./image-dimensions.js";
import type {
  NativeContextImagesRequest,
  NativeImageBinding,
  NativeImageLimits,
  NativeImagePolicy,
  NativeImageRepresentation,
  NativeImageView,
} from "./image-contract.js";

export function nativeImageLimits(input: NativeContextImagesRequest): NativeImageLimits {
  const limits = {
    maxRawBytes: input.maxRawBytes ?? READ_IMAGE_TARGET_BYTES,
    maxBase64Bytes: input.maxBase64Bytes ?? READ_IMAGE_MAX_BASE64_BYTES,
    maxDimension: input.maxDimension ?? READ_IMAGE_MAX_DIMENSION,
  };
  if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 1)) {
    throw createImageProcessorError({
      code: "invalid_request",
      message: "Invalid native image hard budget",
    });
  }
  return limits;
}
export function nativeImagePolicyHash(
  input: NativeContextImagesRequest,
  policy: NativeImagePolicy,
  limits: NativeImageLimits,
  sourceKind: string,
  detail?: string,
): string {
  return nativeHash(
    JSON.stringify([
      "native-image-representation-1",
      policy,
      limits,
      input.model.providerId,
      input.model.modelId,
      input.model.properties.inputFormat,
      sourceKind,
      detail ?? null,
    ]),
  );
}
export function nativeImageFits(
  bytes: Uint8Array,
  dimensions: { width?: number; height?: number },
  limits: NativeImageLimits,
): boolean {
  const measured = nativeImageDimensions(bytes) ?? dimensions;
  return (
    bytes.byteLength <= limits.maxRawBytes &&
    Math.ceil(bytes.byteLength / 3) * 4 <= limits.maxBase64Bytes &&
    (measured.width ?? 0) <= limits.maxDimension &&
    (measured.height ?? 0) <= limits.maxDimension
  );
}
export function assertNativeImageFits(
  bytes: Uint8Array,
  dimensions: { width?: number; height?: number },
  limits: NativeImageLimits,
): void {
  if (!nativeImageFits(bytes, dimensions, limits)) {
    throw createImageProcessorError({
      code: "too_large",
      message: "The exact image cannot fit the model's hard image budget",
    });
  }
}
export function assertNativeUnboundImageFits(dataUrl: string, limits: NativeImageLimits): void {
  const bytes = parseImageDataUrl(dataUrl)?.data;
  if (bytes) assertNativeImageFits(bytes, {}, limits);
}
function imageBlock(binding: NativeImageBinding, data: Uint8Array, mediaType: string) {
  return {
    ...binding.block,
    mediaType,
    dataUrl: "data:" + mediaType + ";base64," + Buffer.from(data).toString("base64"),
    source: {
      ...binding.block.source!,
      mimeType: mediaType,
      sizeBytes: data.byteLength,
      sha256: nativeHash(data),
    },
  };
}
export async function nativeLatchedImageRepresentation(
  runtime: AgentRuntimeInternal,
  binding: NativeImageBinding,
  view: NativeImageView,
  limits: NativeImageLimits,
  signal?: AbortSignal,
): Promise<NativeImageRepresentation> {
  const read = await runtime.artifactStore?.readToolResultBinaryArtifact?.(
    { uri: view.artifactUri, trace: runtime.rootTraceContext },
    { signal },
  );
  if (
    !read ||
    read.bytes.byteLength !== view.bytes ||
    nativeHash(read.bytes) !== view.representationHash
  ) {
    throw new NativeContextRuntimeError("unavailable", "image-copy");
  }
  assertNativeImageFits(read.bytes, {}, limits);
  const original = nativeImageDimensions(binding.bytes) ?? binding.original,
    copy = nativeImageDimensions(read.bytes);
  const resized = Boolean(
    copy &&
    original.width &&
    original.height &&
    (copy.width < original.width || copy.height < original.height),
  );
  return {
    block: imageBlock(binding, read.bytes, view.mediaType),
    view,
    resized,
    annotation:
      view.representationHash === binding.original.sha256
        ? undefined
        : nativeImageCopyAnnotation(binding.source.ref),
  };
}
function nativeImageCopyAnnotation(ref: string): string {
  return (
    "[Image ref=" +
    ref +
    ": sending a smaller copy; the original is available with context_read_image.]"
  );
}
/** 处理原 bytes，性能副本连同说明仍须满足严格收益；原字节从不写回或替换。 */
export async function nativePrepareImageRepresentation(
  runtime: AgentRuntimeInternal,
  input: NativeContextImagesRequest,
  binding: NativeImageBinding,
  policy: NativeImagePolicy,
  limits: NativeImageLimits,
  policyHash: string,
  applyPolicy: boolean,
): Promise<NativeImageRepresentation> {
  input.signal?.throwIfAborted();
  let data = binding.bytes,
    mediaType = binding.original.mediaType,
    resized = false,
    annotation: string | undefined;
  const exact = Boolean(binding.restoredRef || binding.original.preserveRaster);
  const originalFits = nativeImageFits(data, binding.original, limits);
  if (exact || !applyPolicy || !runtime.imageProcessorPort) {
    assertNativeImageFits(data, binding.original, limits);
  } else {
    const prepared = await runtime.imageProcessorPort.prepareForModel(
      {
        data,
        mediaType,
        ...limits,
        nativeContextPolicy: policy,
        sourceKind: binding.source.sourceKind === "other" ? undefined : binding.source.sourceKind,
        targetCapabilityKey:
          input.model.providerId +
          "/" +
          input.model.modelId +
          ":" +
          nativeHash(JSON.stringify(input.model.properties.inputFormat)),
        trace: input.traceContext,
      },
      { signal: input.signal },
    );
    assertNativeImageFits(prepared.data, prepared, limits);
    if (nativeHash(prepared.data) !== binding.original.sha256) {
      const note = nativeImageCopyAnnotation(binding.source.ref);
      const cost = prepared.data.byteLength + Buffer.byteLength(note);
      const benefit =
        cost < data.byteLength &&
        (data.byteLength - cost) * 100 >= data.byteLength * policy.minReductionPercent;
      if (benefit) {
        data = prepared.data;
        mediaType = prepared.mediaType;
        resized = prepared.resized;
        annotation = note;
      } else if (!originalFits) {
        throw createImageProcessorError({
          code: "too_large",
          message: "The image copy cannot meet the configured benefit within the hard budget",
        });
      }
    }
  }
  const representationHash = nativeHash(data);
  let artifactUri = binding.original.artifactUri;
  if (representationHash !== binding.original.sha256) {
    const write = await runtime.artifactStore?.writeToolResultBinaryArtifact?.(
      {
        sessionId: runtime.sessionId,
        toolCallId: input.assistantMessageId + "-image-" + binding.source.ref,
        toolName: "native_context_image",
        content: data,
        contentType: mediaType,
        retention: "session",
        trace: input.traceContext,
      },
      { signal: input.signal },
    );
    if (!write?.uri.startsWith("zcode-artifact://") || write.bytes !== data.byteLength) {
      throw new NativeContextRuntimeError("unavailable", "image-copy-persistence");
    }
    artifactUri = write.uri;
  }
  input.signal?.throwIfAborted();
  return {
    block: imageBlock(binding, data, mediaType),
    view: { artifactUri, mediaType, policyHash, representationHash, bytes: data.byteLength },
    annotation,
    resized,
  };
}
