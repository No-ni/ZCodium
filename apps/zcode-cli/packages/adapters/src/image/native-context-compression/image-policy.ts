import { createImageProcessorError } from "@zcode/contracts";
import {
  createRecommendedNativeContextParameters,
  nativeContextParametersSchema,
  type NativeContextParameters,
} from "@zcode/shared/native-context-compression";
import { createImageBudget, validatePrepareRequest, type ImageBudget } from "../image-budget.js";
import type { NativeContextImagePrepareRequest } from "./contract.js";

export type NativeImagePolicy = NativeContextParameters["images"];

export function validateNativeImageRequest(request: NativeContextImagePrepareRequest): {
  policy: NativeImagePolicy;
  budget: ImageBudget;
  targetRawBytes: number;
  maxDimension: number;
} {
  validatePrepareRequest(request);
  if (
    (request.maxTokens !== undefined && !positiveFinite(request.maxTokens)) ||
    (request.tokenToBase64CharRatio !== undefined &&
      !positiveFinite(request.tokenToBase64CharRatio)) ||
    Math.floor(request.maxDimension) < 1 ||
    (request.sourceKind !== undefined &&
      !["attachment", "read", "bash", "mcp"].includes(request.sourceKind)) ||
    (request.targetCapabilityKey !== undefined && typeof request.targetCapabilityKey !== "string")
  ) {
    throw createImageProcessorError({
      code: "invalid_request",
      message: "Invalid native image model budget or source",
    });
  }

  const parameters = createRecommendedNativeContextParameters();
  parameters.images = request.nativeContextPolicy;
  const parsed = nativeContextParametersSchema.safeParse(parameters);
  if (!parsed.success) {
    throw createImageProcessorError({
      code: "invalid_request",
      message: "Invalid native image compression policy",
    });
  }
  const policy = parsed.data.images;
  const budget = createImageBudget(request);
  const hardRawBytes = effectiveHardRawBytes(budget);
  const targetRawBytes = policy.targetRawKiB === "auto" ? hardRawBytes : policy.targetRawKiB * 1024;
  if (targetRawBytes > hardRawBytes) {
    throw createImageProcessorError({
      code: "invalid_request",
      message: "Image sending target exceeds the model's hard image budget",
    });
  }
  return { policy, budget, targetRawBytes, maxDimension: Math.floor(request.maxDimension) };
}

export function shouldApplyPerformanceGate(
  request: NativeContextImagePrepareRequest,
  policy: NativeImagePolicy,
  originalEdge: number,
  originalBytes: number,
): boolean {
  if (!policy.rescale || !request.sourceKind || !policy.sourceKinds.includes(request.sourceKind))
    return false;
  return (
    originalEdge > policy.maxEdge ||
    (policy.triggerMode === "edge-or-bytes" && originalBytes > policy.byteTriggerKiB * 1024)
  );
}

export function hasRequiredByteBenefit(
  originalBytes: number,
  candidateBytes: number,
  percent: number,
): boolean {
  return (
    candidateBytes < originalBytes &&
    (originalBytes - candidateBytes) * 100 >= originalBytes * percent
  );
}

export function imageBudgetError(): Error {
  return createImageProcessorError({
    code: "too_large",
    message: "Image cannot fit the model budget within the configured quality and dimension floors",
  });
}

function effectiveHardRawBytes(budget: ImageBudget): number {
  const rawFromBase64 = Math.floor(budget.maxBase64Bytes / 4) * 3;
  const rawFromTokens =
    budget.maxTokens === undefined
      ? Number.POSITIVE_INFINITY
      : Math.floor(Math.floor(budget.maxTokens) / budget.tokenToBase64CharRatio / 4) * 3;
  return Math.min(budget.maxRawBytes, rawFromBase64, rawFromTokens);
}

function positiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
