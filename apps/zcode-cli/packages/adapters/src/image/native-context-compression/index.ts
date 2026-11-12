import { createHash } from "node:crypto";
import { createImageProcessorError, type ImagePrepareForModelResult } from "@zcode/contracts";
import { fitsImageBudget } from "../image-budget.js";
import { throwIfAborted } from "../jimp-media.js";
import type { NativeContextImagePreparer } from "./contract.js";
import { NativeImageCopyCache } from "./copy-cache.js";
import { findNativeImageCandidate, nativeCandidateResult } from "./image-candidates.js";
import { decodeNativeImage, prepareNativeAlpha } from "./image-codec.js";
import { inspectNativeImageFormat, normalizeNativeImageMediaType } from "./image-formats.js";
import {
  imageBudgetError,
  shouldApplyPerformanceGate,
  validateNativeImageRequest,
} from "./image-policy.js";

export type * from "./contract.js";

const PROCESSOR_VERSION = "jimp-1.6.1-native-context-1";

export function createNativeContextImagePreparer(): NativeContextImagePreparer {
  const cache = new NativeImageCopyCache();
  return async (request, options = {}) => {
    throwIfAborted(options.signal);
    const { policy, budget, targetRawBytes, maxDimension } = validateNativeImageRequest(request);
    const input = Buffer.from(request.data);
    if (input.byteLength === 0) {
      throw createImageProcessorError({ code: "empty", message: "Image file is empty (0 bytes)" });
    }
    cache.configure(policy);
    const format = inspectNativeImageFormat(input, request.mediaType);
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          PROCESSOR_VERSION,
          createHash("sha256").update(input).digest("hex"),
          policy,
          budget,
          maxDimension,
          format.mediaType,
          request.mediaType,
          request.sourceKind ?? null,
          request.targetCapabilityKey ?? null,
        ]),
      )
      .digest("hex");
    const cached = cache.get(key);
    if (cached) return cached;

    if (format.passthrough) {
      if (!fitsImageBudget(input, budget) || exceedsDimensions(format, maxDimension))
        throw imageBudgetError();
      return originalResult(input, format.mediaType, format);
    }

    const image = await decodeNativeImage(input, options.signal);
    const original = { width: image.bitmap.width, height: image.bitmap.height };
    const originalEdge = Math.max(original.width, original.height);
    const sourceMediaType = normalizeNativeImageMediaType(image.mime ?? format.mediaType);
    const hardFits = fitsImageBudget(input, budget) && !exceedsDimensions(original, maxDimension);
    if (!["image/png", "image/jpeg", "image/bmp"].includes(sourceMediaType)) {
      if (!hardFits) throw imageBudgetError();
      return originalResult(input, sourceMediaType, original);
    }
    const gate = shouldApplyPerformanceGate(request, policy, originalEdge, input.byteLength);
    if (hardFits && !gate) return originalResult(input, sourceMediaType, original);

    const minimumEdge = Math.min(originalEdge, policy.minEdge);
    const startEdge = Math.min(originalEdge, maxDimension, gate ? policy.maxEdge : originalEdge);
    if (startEdge < minimumEdge) throw imageBudgetError();
    const candidate = await findNativeImageCandidate({
      image: prepareNativeAlpha(image, policy),
      sourceMediaType,
      originalSizeBytes: input.byteLength,
      policy,
      budget,
      targetRawBytes,
      startEdge,
      minimumEdge,
      signal: options.signal,
    });
    throwIfAborted(options.signal);
    if (!candidate) {
      if (hardFits) return originalResult(input, sourceMediaType, original);
      throw imageBudgetError();
    }
    const result = nativeCandidateResult(candidate, { ...original, sizeBytes: input.byteLength });
    cache.put(key, result);
    return result;
  };
}

function originalResult(
  data: Buffer,
  mediaType: string,
  dimensions: { width?: number; height?: number },
): ImagePrepareForModelResult {
  return {
    data,
    mediaType,
    originalWidth: dimensions.width,
    originalHeight: dimensions.height,
    width: dimensions.width,
    height: dimensions.height,
    originalSizeBytes: data.byteLength,
    transformedSizeBytes: data.byteLength,
    resized: false,
    compressed: false,
    strategy: "original",
  };
}

function exceedsDimensions(
  dimensions: { width?: number; height?: number },
  maxDimension: number,
): boolean {
  return (dimensions.width ?? 0) > maxDimension || (dimensions.height ?? 0) > maxDimension;
}
