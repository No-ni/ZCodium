import {
  MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE_ERROR_CODE,
  type Model,
  type ModelInputMessage,
} from "@zcode/contracts";
import type { NativeContextStoredState } from "@zcode/shared/native-context-compression";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RunModelTextRequestOptions, RuntimeModelTextResult } from "../types.js";
import { projectMessagesWithMediaAttachmentPaths } from "../helpers/media-attachment-path.js";
import {
  projectMessagesForInputFormat,
  logMediaCapabilityProjection,
} from "../helpers/media-capability.js";
import {
  projectMessagesForMediaBudget,
  logMediaBudgetProjection,
} from "../helpers/media-budget.js";
import { logModelRequestMediaSummary } from "../helpers/media-observability.js";
import { NativeContextRuntimeError, type NativeContextAttemptTracker } from "./contract.js";
import { prepareNativeContextImages, commitNativeImageReceipts } from "./images.js";
import type { NativeContextImagesResult } from "./image-contract.js";
import { nativeImageSource } from "./image-identity.js";
import { nativeOwner } from "./state.js";
import { createNativeAttemptTracker } from "./attempts.js";
import { resolveNormalRequestMaxOutputTokens } from "../methods/model-token-limits.js";

export interface NativeModelPreparation {
  options: RunModelTextRequestOptions;
  tracker?: NativeContextAttemptTracker;
  sentImages: NativeContextImagesResult["sentImages"];
}

/** 对照不可发送时保留文本/模态事实，不把空数组当成零成本。 */
export function nativeModelBaseline(
  messages: ModelInputMessage[],
  model: Model,
  latestRealUserMessageIndex?: number,
) {
  const capability = projectMessagesForInputFormat(messages, model.properties.inputFormat).messages;
  try {
    return {
      messages: projectMessagesForMediaBudget(capability, { latestRealUserMessageIndex }).messages,
      baselineMeasurable: true,
    };
  } catch (error) {
    if ((error as { code?: string }).code !== MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE_ERROR_CODE)
      throw error;
    return { messages: capability, baselineMeasurable: false };
  }
}

/** 最终能力/容量 gate 会克隆媒体块，按 canonical FilePart 过滤，不能按 bytes 合并重复图。 */
export function retainNativeSentImages(
  state: NativeContextStoredState,
  prepared: NativeContextImagesResult,
  finalMessages: ModelInputMessage[],
): void {
  const sent = new Set<string>(),
    restored = new Set<string>();
  for (const message of finalMessages)
    if (Array.isArray(message.content))
      for (const block of message.content)
        if (block.type === "image") {
          const ref = nativeImageSource(state, block)?.ref;
          if (!ref || !prepared.sentImages.some((receipt) => receipt.ref === ref)) continue;
          sent.add(ref);
          if (block.source?.id.startsWith("context-original-"))
            restored.add(block.source.id.slice("context-original-".length));
        }
  if (prepared.imageChanges.restoredRefs.some((ref) => !restored.has(ref))) {
    throw new NativeContextRuntimeError("unavailable", "original-image-capacity");
  }
  const dropped = prepared.sentImages
    .filter((receipt) => !sent.has(receipt.ref))
    .map((receipt) => receipt.ref);
  // 图片候选用原数组作为 WeakMap 键，原地过滤才能保持提交证明。
  prepared.sentImages.splice(
    0,
    prepared.sentImages.length,
    ...prepared.sentImages.filter((receipt) => sent.has(receipt.ref)),
  );
  prepared.imageChanges.resizedRefs = prepared.imageChanges.resizedRefs.filter((ref) =>
    sent.has(ref),
  );
  prepared.imageChanges.omittedRefs = [
    ...new Set([...prepared.imageChanges.omittedRefs, ...dropped]),
  ];
}

export async function prepareNativeModelRequest(
  runtime: AgentRuntimeInternal,
  options: RunModelTextRequestOptions,
): Promise<NativeModelPreparation> {
  const model = options.model;
  const mediaPathMessages = await projectMessagesWithMediaAttachmentPaths(
    options.messages,
    runtime.artifactStore,
  );
  const images = await prepareNativeContextImages(runtime, {
    messages: mediaPathMessages,
    model,
    assistantMessageId: options.assistantMessageId,
    comparison: options.nativeContextComparison,
    traceContext: options.traceContext,
    signal: options.abortSignal,
  });
  const capabilityProjection = projectMessagesForInputFormat(
    images.messages,
    model.properties.inputFormat,
  );
  logMediaCapabilityProjection(runtime.logger, options.traceContext, capabilityProjection, {
    event: "model.request.media_capability_projection",
    message: "Model request media capability projection",
    model: model.providerId + "/" + model.modelId,
  });
  const mediaProjection = projectMessagesForMediaBudget(capabilityProjection.messages, {
    latestRealUserMessageIndex: options.latestRealUserMessageIndex,
  });
  logMediaBudgetProjection(runtime.logger, options.traceContext, mediaProjection, {
    event: "model.request.media_projection",
    message: "Model request media budget projection",
  });
  const projectedOptions =
    mediaProjection.messages === options.messages
      ? options
      : { ...options, messages: mediaProjection.messages };
  logModelRequestMediaSummary(runtime.logger, options.traceContext, {
    incomingMessages: options.messages,
    mediaProjection,
    providerMessages: projectedOptions.messages,
  });
  const comparison = options.nativeContextComparison;
  if (!comparison) return { options: projectedOptions, sentImages: images.sentImages };
  retainNativeSentImages(nativeOwner(runtime).state!, images, projectedOptions.messages);
  const baselinePaths = await projectMessagesWithMediaAttachmentPaths(
    comparison.baselineMessages,
    runtime.artifactStore,
  );
  // before 与 after 的 latest user 索引独立；摘要/工具投影可能改变请求消息个数。
  const baseline = nativeModelBaseline(
    baselinePaths,
    model,
    comparison.baselineLatestRealUserMessageIndex,
  );
  const tracker = createNativeAttemptTracker(runtime, {
    comparison,
    policy: comparison.policy,
    model,
    // 用量归属本轮真实 assistant，避免回退或 fork 按用户锚点误保留本轮费用与观察。
    anchorMessageId: options.assistantMessageId,
    beforeMessages: baseline.messages,
    baselineMeasurable: baseline.baselineMeasurable,
    afterMessages: projectedOptions.messages,
    tools: projectedOptions.tools,
    maxOutputTokens:
      options.maxOutputTokens ??
      resolveNormalRequestMaxOutputTokens({
        modelMaxOutputTokens: model.optionSpecs.maxOutputTokens.max,
      }),
    traceContext: options.traceContext,
    sentImages: images.sentImages,
    imageChanges: images.imageChanges,
    querySource:
      typeof options.traceContext.attributes?.querySource === "string"
        ? options.traceContext.attributes.querySource
        : "main_turn",
  });
  return {
    options: {
      ...projectedOptions,
      onModelNetworkStatus: async (event) => {
        try {
          await tracker.onStatus(event);
        } finally {
          await options.onModelNetworkStatus?.(event);
        }
      },
    },
    tracker,
    sentImages: images.sentImages,
  };
}

/** 回复先完整保存；可恢复的图片状态失败不能把已保存回复改成模型失败。 */
export async function commitNativeModelResultImages(
  runtime: AgentRuntimeInternal,
  result: RuntimeModelTextResult,
): Promise<void> {
  const commit = result.nativeImageCommit;
  if (!commit) return;
  try {
    await commitNativeImageReceipts(runtime, commit.receipts, commit.comparison);
  } catch (error) {
    runtime.logger?.warn("Native image receipt commit skipped", {
      event: "native_context.image_receipt.commit_skipped",
      module: "core.runtime",
      reason:
        error instanceof NativeContextRuntimeError && error.code === "conflict"
          ? "stale-candidate"
          : "commit-failed",
    });
  }
}
