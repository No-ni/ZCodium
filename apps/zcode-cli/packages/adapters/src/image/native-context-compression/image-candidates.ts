import type { ImagePrepareForModelResult } from "@zcode/contracts";
import { fitsImageBudget, type ImageBudget } from "../image-budget.js";
import { throwIfAborted } from "../jimp-media.js";
import {
  encodeNativeImageCandidates,
  resizeNativeImage,
  type NativeImageCandidate,
  type NativeJimpImage,
} from "./image-codec.js";
import { hasRequiredByteBenefit, type NativeImagePolicy } from "./image-policy.js";

export async function findNativeImageCandidate(input: {
  image: NativeJimpImage;
  sourceMediaType: string;
  originalSizeBytes: number;
  policy: NativeImagePolicy;
  budget: ImageBudget;
  targetRawBytes: number;
  startEdge: number;
  minimumEdge: number;
  signal?: AbortSignal;
}): Promise<NativeImageCandidate | undefined> {
  let firstHardFitting: NativeImageCandidate | undefined;
  for (const edge of imageEdges(input.startEdge, input.minimumEdge)) {
    throwIfAborted(input.signal);
    const resized = resizeNativeImage(input.image, edge);
    const dimensionsChanged =
      resized.bitmap.width !== input.image.bitmap.width ||
      resized.bitmap.height !== input.image.bitmap.height;
    for await (const candidate of encodeNativeImageCandidates(
      resized,
      input.sourceMediaType,
      input.policy,
      dimensionsChanged,
      input.signal,
    )) {
      if (
        !fitsImageBudget(candidate.data, input.budget) ||
        !hasRequiredByteBenefit(
          input.originalSizeBytes,
          candidate.data.byteLength,
          input.policy.minReductionPercent,
        )
      )
        continue;
      firstHardFitting ??= candidate;
      if (candidate.data.byteLength <= input.targetRawBytes) return candidate;
    }
  }
  return firstHardFitting;
}

export function nativeCandidateResult(
  candidate: NativeImageCandidate,
  original: { width: number; height: number; sizeBytes: number },
): ImagePrepareForModelResult {
  return {
    data: candidate.data,
    mediaType: candidate.mediaType,
    originalWidth: original.width,
    originalHeight: original.height,
    originalSizeBytes: original.sizeBytes,
    width: candidate.width,
    height: candidate.height,
    resized: candidate.width !== original.width || candidate.height !== original.height,
    compressed: true,
    strategy: candidate.strategy,
    transformedSizeBytes: candidate.data.byteLength,
    ...(candidate.quality === undefined ? {} : { quality: candidate.quality }),
  };
}

function imageEdges(start: number, minimum: number): number[] {
  const values = [start];
  let current = start;
  while (current > minimum) {
    current = Math.max(minimum, Math.floor(current * 0.75));
    values.push(current);
  }
  return values;
}
