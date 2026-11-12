import { activeBlocks } from "acp-kernel";
import { createImageProcessorError } from "@zcode/contracts";
import type {
  ModelImageContentBlock,
  ModelInputMessage,
  ModelMessageContentBlock,
} from "@zcode/contracts";
import type { NativeContextImageReceipt } from "@zcode/shared/native-context-compression";
import type { AgentRuntimeInternal } from "../internal.js";
import { nativeOwner, ensureNativeState, kernelOf } from "./state.js";
import { ownedNativeImage } from "./read.js";
import { nativeCountTokens } from "./measurements.js";
import { nativeHash } from "./identity.js";
import { nativeMessageId, protectedNativeIds } from "./guards.js";
import { NativeContextRuntimeError } from "./contract.js";
import {
  matchingNativeImageReceipt,
  nativeImageSource,
  nativeRecentImageGroups,
  nativeImageBelongsToBaseline,
} from "./image-identity.js";
import { assertNativeImageBoundary, stageNativeImageReceipts } from "./image-receipts.js";
import {
  assertNativeUnboundImageFits,
  nativeImageLimits,
  nativeImagePolicyHash,
  nativeLatchedImageRepresentation,
  nativePrepareImageRepresentation,
} from "./image-copies.js";
import { nativeRestoredImageRef } from "./image-restores.js";
import type {
  NativeContextImagesRequest,
  NativeContextImagesResult,
  NativeImageBinding,
  NativeImageView,
} from "./image-contract.js";

export type {
  NativeContextImagesRequest,
  NativeContextImagesResult,
  NativeContextImageChanges,
} from "./image-contract.js";
export { commitNativeImageReceipts } from "./image-receipts.js";

/** 最终 Provider 副本；不改 canonical 内容，失败或取消的 attempt 不提交任何图片视图/回执。 */
export async function prepareNativeContextImages(
  runtime: AgentRuntimeInternal,
  input: NativeContextImagesRequest,
): Promise<NativeContextImagesResult> {
  const sentImages: NativeContextImageReceipt[] = [];
  const imageChanges: NativeContextImagesResult["imageChanges"] = {
    omittedRefs: [],
    foldedRefs: [],
    resizedRefs: [],
    restoredRefs: [],
  };
  if (
    !input.comparison ||
    !runtime.sessionPersisted ||
    !runtime.sessionStore?.commitNativeContext
  ) {
    return { messages: input.messages, sentImages, imageChanges };
  }
  const owner = nativeOwner(runtime);
  await ensureNativeState(owner);
  await owner.serial;
  assertNativeImageBoundary(runtime, owner.state!, input.comparison);
  // 参数完整冻结在本次 comparison 内；异步读图/编码中不得改用后来保存的策略。
  const state = structuredClone(owner.state!);
  state.policy = structuredClone(input.comparison.policy);
  const policy = state.policy.parameters.images,
    limits = nativeImageLimits(input);
  if (
    policy.targetRawKiB !== "auto" &&
    policy.targetRawKiB * 1024 >
      Math.min(limits.maxRawBytes, Math.floor(limits.maxBase64Bytes / 4) * 3)
  ) {
    throw createImageProcessorError({
      code: "invalid_request",
      message: "Image sending target exceeds the model's hard image budget",
    });
  }
  const kernel = kernelOf(state),
    mode = state.policy.mode;
  const supportsImage = input.model.properties.inputFormat.supportsImage;
  const modelKey = input.model.providerId + "/" + input.model.modelId;
  const intents = new Set(owner.restoreImageRefs);
  const bindings = new Map<ModelImageContentBlock, NativeImageBinding>();
  const restoreTargets = new Set<string>();
  const sources = new Map<string, NativeImageBinding["source"]>();
  for (const message of input.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type !== "image") continue;
      input.signal?.throwIfAborted();
      const source = nativeImageSource(state, block);
      if (!source) continue;
      if (
        !nativeImageBelongsToBaseline(source, block, input.comparison.baselineEntries) ||
        sources.has(source.ref)
      ) {
        throw new NativeContextRuntimeError("invalid-state", "image-identity");
      }
      const original = await ownedNativeImage(owner, source, input.signal);
      if (!original) continue;
      const binding: NativeImageBinding = { block, source, ...original };
      binding.restoredRef = await nativeRestoredImageRef(owner, state, input, binding, intents);
      if (binding.restoredRef && !supportsImage)
        throw new NativeContextRuntimeError("unavailable", "model-image-capability");
      if (binding.restoredRef) restoreTargets.add(binding.restoredRef);
      bindings.set(block, binding);
      sources.set(source.ref, source);
    }
  }
  const protectedIds = protectedNativeIds(
    input.comparison.baselineEntries,
    state,
    nativeCountTokens,
  );
  const recent = nativeRecentImageGroups(
    input.comparison.baselineEntries,
    policy.keepRecentUserTurns,
  );
  const latest = nativeRecentImageGroups(input.comparison.baselineEntries, 1);
  const covered = new Set(
    activeBlocks(kernel.compression).flatMap((block) =>
      block.effectiveMessageIds.map(nativeMessageId),
    ),
  );
  const views = new Map<string, NativeImageView>(),
    omitted = new Set<string>(),
    restores = new Map<string, string>();
  let changed = false;
  const messages: ModelInputMessage[] = [];
  for (const message of input.messages) {
    if (!Array.isArray(message.content)) {
      messages.push(message);
      continue;
    }
    const originalContent = message.content;
    const content: ModelMessageContentBlock[] = [];
    for (const block of message.content) {
      if (block.type !== "image") {
        content.push(block);
        continue;
      }
      const binding = bindings.get(block);
      if (!binding) {
        if (supportsImage) assertNativeUnboundImageFits(block.dataUrl, limits);
        content.push(block);
        continue;
      }
      const { source } = binding;
      const rawId = source.rawId.replace(/:image\d+$/u, "");
      const hardProtected = protectedIds.has(rawId),
        exact = Boolean(binding.restoredRef || binding.original.preserveRaster);
      // 回取的新工具 FilePart 是唯一此次原图 carrier，不能再重复发送旧 ref 的历史图。
      if (restoreTargets.has(source.ref) && !binding.restoredRef) {
        content.push({
          type: "text",
          text: "[Image ref=" + source.ref + ": original restored by context_read_image below.]",
        });
        imageChanges.omittedRefs.push(source.ref);
        changed = true;
        continue;
      }
      // 原因：auto 无条件延续旧省略会绕过 NCTX-43 的模型/编码证明检查，也无法关闭 omitSeen。
      // 只有 manual 保持已提交投影；auto 使用下方本次冻结策略与实际表示重新判断。
      const latchedOmission =
        mode === "manual" &&
        kernel.omittedImageRefs?.includes(source.ref) &&
        !latest.has(source.messageId) &&
        !exact;
      if (latchedOmission) {
        content.push({
          type: "text",
          text: "[Image ref=" + source.ref + ": original available with context_read_image.]",
        });
        imageChanges.omittedRefs.push(source.ref);
        changed = true;
        continue;
      }
      if (!supportsImage) {
        content.push(block);
        continue;
      }
      const ordinaryPolicyHash = nativeImagePolicyHash(
        input,
        policy,
        limits,
        source.sourceKind,
        block.detail,
      );
      // 一次请求的原图例外不能伪装成普通编码缓存，下一请求必须重新按普通策略判断。
      const policyHash = binding.restoredRef
        ? nativeHash(JSON.stringify([ordinaryPolicyHash, "restore-once", binding.restoredRef]))
        : ordinaryPolicyHash;
      const oldView = kernel.imageViews?.[source.ref];
      const representation =
        oldView && !exact && (mode === "manual" || oldView.policyHash === policyHash)
          ? await nativeLatchedImageRepresentation(runtime, binding, oldView, limits, input.signal)
          : await nativePrepareImageRepresentation(
              runtime,
              input,
              binding,
              policy,
              limits,
              policyHash,
              mode === "auto",
            );
      const wasReceived = Boolean(
        matchingNativeImageReceipt(state, source, representation.view, modelKey),
      );
      const folded =
        mode === "auto" &&
        policy.foldWithHistory &&
        covered.has(source.messageId) &&
        !hardProtected &&
        !exact &&
        wasReceived;
      const seen =
        mode === "auto" &&
        policy.omitSeen &&
        !recent.has(source.messageId) &&
        !hardProtected &&
        !exact &&
        wasReceived;
      if (folded || seen) {
        content.push({
          type: "text",
          text: "[Image ref=" + source.ref + ": original available with context_read_image.]",
        });
        omitted.add(source.ref);
        imageChanges.omittedRefs.push(source.ref);
        if (folded) imageChanges.foldedRefs.push(source.ref);
      } else {
        content.push(representation.block);
        if (representation.annotation)
          content.push({ type: "text", text: representation.annotation });
        sentImages.push({
          ref: source.ref,
          responseMessageId: input.assistantMessageId,
          logicalRequestId: "pending",
          modelKey,
          policyHash: representation.view.policyHash,
          representationHash: representation.view.representationHash,
          generation: state.generation,
        });
        views.set(source.ref, representation.view);
        if (representation.resized) imageChanges.resizedRefs.push(source.ref);
        if (binding.restoredRef) {
          restores.set(source.ref, binding.restoredRef);
          imageChanges.restoredRefs.push(binding.restoredRef);
        }
      }
      changed ||= representation.block !== block || folded || seen;
    }
    messages.push(
      content.length === originalContent.length &&
        content.every((block, index) => block === originalContent[index])
        ? message
        : { ...message, content },
    );
  }
  input.signal?.throwIfAborted();
  assertNativeImageBoundary(runtime, owner.state!, input.comparison);
  stageNativeImageReceipts(runtime, sentImages, {
    comparison: input.comparison,
    assistantMessageId: input.assistantMessageId,
    modelKey,
    model: { providerId: input.model.providerId, modelId: input.model.modelId },
    sources: [...sources.values()],
    views,
    omittedRefs: omitted,
    restores,
    signal: input.signal,
  });
  return { messages: changed ? messages : input.messages, sentImages, imageChanges };
}
