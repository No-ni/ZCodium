import type { ModelNetworkStatusEvent, ModelUsage } from "@zcode/contracts";
import {
  nativeContextPolicySchema,
  type NativeContextObservation,
} from "@zcode/shared/native-context-compression";
import { providerModelUsageIdentity } from "../model-usage-observability/index.js";
import { NativeContextRuntimeError, type NativeContextAttemptTrackerInput } from "./contract.js";
import {
  nativeActualInput,
  nativeImageMeasurement,
  nativeKnownCount,
  nativeMeasurementScope,
  nativeTextEstimate,
} from "./measurements.js";
import { nativeThresholdTokens } from "./kernel-config.js";

type Meter = Pick<
  NativeContextObservation,
  | "measurementScope"
  | "contextWindow"
  | "inputBudget"
  | "startTokens"
  | "targetTokens"
  | "beforeEstimate"
  | "afterEstimate"
  | "textBeforeEstimate"
  | "textAfterEstimate"
  | "images"
>;
export interface FrozenNativeAttempt {
  generation: number;
  historyVersion: string;
  policyVersion: number;
  segmentId: string;
  purpose: NativeContextObservation["purpose"];
  querySource: string;
  operationIds: string[];
  anchorMessageId: string | null;
  model: { providerId: string; modelId: string };
  meter: Meter;
}

/** 不持有消息原文；发送前同步冻结计数、完整 policy 和请求边界。 */
export function freezeNativeAttempt(input: NativeContextAttemptTrackerInput): FrozenNativeAttempt {
  const policy = nativeContextPolicySchema.parse(input.policy);
  if (policy.policyVersion !== input.comparison.policyVersion) {
    throw new NativeContextRuntimeError("invalid-state", "attempt-policy");
  }
  const contextWindow = nativeKnownCount(input.model.properties.contextWindow);
  const maxOutput = nativeKnownCount(input.maxOutputTokens);
  const inputBudget =
    contextWindow !== null && contextWindow > 0 && maxOutput !== null
      ? Math.max(0, contextWindow - maxOutput)
      : null;
  const measurementScope = nativeMeasurementScope([
    ...input.beforeMessages,
    ...input.afterMessages,
  ]);
  const beforeScope = nativeMeasurementScope(input.beforeMessages);
  const afterScope = nativeMeasurementScope(input.afterMessages);
  const textBeforeEstimate = nativeTextEstimate(input.beforeMessages, input.tools);
  const textAfterEstimate = nativeTextEstimate(input.afterMessages, input.tools);
  const uniqueCount = (refs: readonly string[]) => new Set(refs).size;
  const purpose = input.purpose ?? "main";
  const images = nativeImageMeasurement(input.beforeMessages, input.afterMessages, {
    omittedCount: uniqueCount(input.imageChanges.omittedRefs),
    foldedCount: uniqueCount(input.imageChanges.foldedRefs),
    resizedCount: uniqueCount(input.imageChanges.resizedRefs),
    restoredCount: uniqueCount(input.imageChanges.restoredRefs),
  });
  // 原图对照超过同一发送硬上限时没有可发送的 before；文字分量仍独立可测，不能伪造完整收益。
  if (input.baselineMeasurable === false) images.beforeBytes = null;
  return {
    generation: input.comparison.generation,
    historyVersion: input.comparison.historyVersion,
    policyVersion: policy.policyVersion,
    segmentId: input.comparison.segmentId,
    purpose,
    querySource:
      input.querySource ?? (purpose === "main" ? "main_turn" : `native_context_${purpose}`),
    operationIds: [
      ...new Set([
        ...input.comparison.operationIds,
        ...(input.operationId ? [input.operationId] : []),
      ]),
    ].slice(-100),
    anchorMessageId:
      input.anchorMessageId === undefined
        ? (input.comparison.baselineEntries.findLast((entry) => entry.canonical)?.canonical
            ?.messageId ?? null)
        : input.anchorMessageId,
    model: { providerId: input.model.providerId, modelId: input.model.modelId },
    meter: {
      measurementScope,
      contextWindow: contextWindow !== null && contextWindow > 0 ? contextWindow : null,
      inputBudget,
      startTokens:
        inputBudget === null
          ? null
          : nativeThresholdTokens(policy.parameters.trigger.start, inputBudget),
      targetTokens:
        inputBudget === null
          ? null
          : nativeThresholdTokens(policy.parameters.trigger.target, inputBudget),
      beforeEstimate:
        input.baselineMeasurable !== false && beforeScope === "complete"
          ? textBeforeEstimate
          : null,
      afterEstimate: afterScope === "complete" ? textAfterEstimate : null,
      textBeforeEstimate,
      textAfterEstimate,
      images,
    },
  };
}

export function nativeAttemptTime(event: Pick<ModelNetworkStatusEvent, "timestamp">): number {
  const at = Date.parse(event.timestamp);
  return Number.isFinite(at) && at >= 0 ? Math.floor(at) : Date.now();
}

export function prepareNativeAttempt(
  frozen: FrozenNativeAttempt,
  event: ModelNetworkStatusEvent,
  requestSeq: number,
): NativeContextObservation {
  const identity = providerModelUsageIdentity(frozen.querySource, event);
  const sameModel =
    frozen.model.providerId === event.providerId && frozen.model.modelId === event.modelId;
  return {
    id: identity.id,
    usageRecordRef: identity.id,
    logicalRequestId: identity.logicalRequestId,
    attemptIndex: identity.attemptIndex,
    requestSeq,
    purpose: frozen.purpose,
    status: "prepared",
    anchorMessageId: frozen.anchorMessageId,
    generation: frozen.generation,
    historyVersion: frozen.historyVersion,
    policyVersion: frozen.policyVersion,
    segmentId: frozen.segmentId,
    model: { providerId: event.providerId, modelId: event.modelId },
    estimatorVersion: "native-context-v1",
    ...frozen.meter,
    contextWindow: sameModel ? frozen.meter.contextWindow : null,
    inputBudget: sameModel ? frozen.meter.inputBudget : null,
    startTokens: sameModel ? frozen.meter.startTokens : null,
    targetTokens: sameModel ? frozen.meter.targetTokens : null,
    actualInputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreateTokens: null,
    visionTokens: null,
    operationIds: frozen.operationIds,
    origin: "own",
    createdAt: nativeAttemptTime(event),
    completedAt: null,
  };
}

export function settleNativeAttempt(
  observation: NativeContextObservation,
  status: Exclude<NativeContextObservation["status"], "prepared">,
  usage: ModelUsage | undefined,
  completedAt: number,
): NativeContextObservation {
  return {
    ...observation,
    status,
    completedAt,
    actualInputTokens: nativeActualInput(usage),
    outputTokens: nativeKnownCount(usage?.outputTokens),
    cacheReadTokens: nativeKnownCount(usage?.cacheReadTokens),
    cacheCreateTokens: nativeKnownCount(usage?.cacheWriteTokens),
    // 图片 decoded bytes 只能用于传输趋势；归一化端口没有报告 vision tokens。
    visionTokens: null,
  };
}
