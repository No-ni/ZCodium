import { isImageProcessorPortError } from "@zcode/contracts";
import type {
  MessageId,
  Model,
  ModelImageContentBlock,
  ModelInputMessage,
  ModelMessageContentBlock,
} from "@zcode/contracts";
import type {
  NativeContextSource,
  NativeContextStoredState,
} from "@zcode/shared/native-context-compression";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { projectMessagesForMediaBudget } from "../helpers/media-budget.js";
import type { NativeContextRequestComparison, NativeContextSafePoint } from "./contract.js";
import { NativeContextRuntimeError } from "./contract.js";
import {
  nativeImageLimits,
  nativeImagePolicyHash,
  nativePrepareImageRepresentation,
} from "./image-copies.js";
import type { NativeContextImagesRequest } from "./image-contract.js";
import { assertNativeImageBoundary } from "./image-receipts.js";
import { historyVersionOf, nativeRawId } from "./identity.js";
import { ownedNativeImage } from "./read.js";
import { nativeOwner } from "./state.js";
import type { NativeContextStateOwner } from "./state.js";
import type { NativeOutputCandidate } from "./tool-views.js";

const MAX_MAINTENANCE_OUTPUTS = 20;
const MAX_MAINTENANCE_IMAGES = 200;
type MediaFailure = "source" | "unsupported" | "capacity";

interface NativeMaintenanceMediaInput {
  state: NativeContextStoredState;
  model: Model;
  safePoint: NativeContextSafePoint;
  outputs: readonly NativeOutputCandidate[];
  messages: ModelInputMessage[];
  operationId: string;
}
interface OfferedImage {
  block: ModelImageContentBlock;
  source: NativeContextSource;
}
interface OfferedOutput {
  output: NativeOutputCandidate;
  entryIdentity: string;
  images: OfferedImage[];
}

function mediaError(reason: MediaFailure, cause?: unknown): NativeContextRuntimeError {
  const error = new NativeContextRuntimeError("unavailable", "maintenance-media-" + reason);
  if (cause !== undefined) error.cause = cause;
  return error;
}
function stoppedError(cause?: unknown): NativeContextRuntimeError {
  const error = new NativeContextRuntimeError("conflict", "maintenance-media-cancelled");
  if (cause !== undefined) error.cause = cause;
  return error;
}
function entryIdentity(entry: RuntimeMessageEntry): string {
  return JSON.stringify([
    historyVersionOf([entry]),
    entry.canonical?.partId,
    entry.canonical?.imagePartIds,
  ]);
}
function collectOfferedImages(input: NativeMaintenanceMediaInput): OfferedOutput[] {
  if (input.outputs.length > MAX_MAINTENANCE_OUTPUTS) throw mediaError("capacity");
  const offered: OfferedOutput[] = [];
  const refs = new Set<string>();
  let imageCount = 0;
  for (const output of input.outputs) {
    const entry = output.entry;
    if (entry.kind === "attachment" || !Array.isArray(entry.message.content)) continue;
    if (
      entry.message.content.some(
        (block) =>
          block.type === "video" ||
          (block.type === "file" && Boolean(block.dataUrl) && !block.text),
      )
    ) {
      throw mediaError("unsupported");
    }
    const blocks = entry.message.content.filter((block) => block.type === "image");
    imageCount += blocks.length;
    if (imageCount > MAX_MAINTENANCE_IMAGES) throw mediaError("capacity");
    if (!blocks.length) continue;
    const source = input.state.sources.find((item) => item.rawId === output.rawId);
    const baseline = input.safePoint.entries.find((item) => nativeRawId(item) === output.rawId);
    if (
      entry.message.role !== "tool" ||
      !entry.canonical?.partId ||
      nativeRawId(entry) !== output.rawId ||
      !source ||
      source.kind !== "tool-result" ||
      source.ref !== output.ref ||
      JSON.stringify(source) !== JSON.stringify(output.source) ||
      !baseline ||
      entryIdentity(baseline) !== entryIdentity(entry) ||
      refs.has(output.ref)
    )
      throw mediaError("source");
    refs.add(output.ref);
    const images = blocks.map((block, imageIndex): OfferedImage => {
      const partId = entry.canonical!.imagePartIds?.[imageIndex] ?? block.source?.canonicalPartId;
      const imageSource = input.state.sources.find(
        (item) => item.rawId === output.rawId + ":image" + imageIndex,
      );
      if (
        !partId ||
        !imageSource ||
        imageSource.kind !== "image" ||
        !imageSource.originalAvailable ||
        imageSource.partId !== partId ||
        imageSource.messageId !== source.messageId ||
        imageSource.entryIndex !== source.entryIndex ||
        imageSource.imageIndex !== imageIndex ||
        refs.has(imageSource.ref)
      )
        throw mediaError("source");
      refs.add(imageSource.ref);
      return { block, source: structuredClone(imageSource) };
    });
    offered.push({ output, images, entryIdentity: entryIdentity(entry) });
  }
  return offered;
}

async function assertStoredOutput(
  owner: NativeContextStateOwner,
  offered: OfferedOutput,
): Promise<void> {
  const runtime = owner.runtime,
    source = offered.output.source,
    entry = offered.output.entry;
  if (entry.kind === "attachment") throw mediaError("source");
  const message = await runtime.sessionStore?.messageWithParts({
    sessionID: runtime.sessionId,
    messageID: source.messageId as MessageId,
  });
  const part = message?.parts.find((item) => item.id === source.partId);
  if (
    !message ||
    message.info.id !== source.messageId ||
    message.info.sessionID !== runtime.sessionId ||
    message.info.role !== "assistant" ||
    part?.type !== "tool" ||
    part.messageID !== source.messageId ||
    part.sessionID !== runtime.sessionId ||
    part.callID !== entry.message.toolCallId ||
    part.tool !== entry.message.toolName ||
    part.state.status !== "completed"
  )
    throw mediaError("source");
  for (const { source: image } of offered.images) {
    const attachment = part.state.attachments?.find((item) => item.id === image.partId);
    if (
      !attachment ||
      attachment.messageID !== source.messageId ||
      attachment.sessionID !== runtime.sessionId
    )
      throw mediaError("source");
  }
}

/** 维护请求携带工具真正拥有的图；既有省略和已提供回执不能证明这个新请求看过图。 */
export async function prepareNativeMaintenanceMedia(
  runtime: AgentRuntimeInternal,
  input: NativeMaintenanceMediaInput,
): Promise<ModelInputMessage[]> {
  if (input.safePoint.signal?.aborted) throw stoppedError(input.safePoint.signal.reason);
  const offered = collectOfferedImages(input);
  if (!offered.length) return input.messages;
  if (!input.model.properties.inputFormat.supportsImage) throw mediaError("unsupported");
  const userIndex = input.messages.findLastIndex((message) => message.role === "user");
  if (userIndex < 0) throw mediaError("source");
  const comparison: NativeContextRequestComparison = {
    baselineMessages: input.messages,
    baselineEntries: input.safePoint.entries,
    generation: input.state.generation,
    historyVersion: input.state.historyVersion,
    policyVersion: input.state.policy.policyVersion,
    policy: structuredClone(input.state.policy),
    segmentId: input.state.compactBoundaryId,
    operationIds: [input.operationId],
  };
  const owner = nativeOwner(runtime);
  const assertCurrent = async (): Promise<void> => {
    if (input.safePoint.signal?.aborted) throw stoppedError(input.safePoint.signal.reason);
    await owner.serial;
    if (!owner.state) throw mediaError("source");
    // preparing/running 的记账会增加 revision；只冻结真实分支、策略和来源，避免废弃本次合法操作。
    assertNativeImageBoundary(runtime, owner.state, comparison);
    const entries = new Map(
      runtime.messageHistory
        .borrowReadOnlyRuntimeEntries()
        .map((entry) => [nativeRawId(entry), entry]),
    );
    const sources = new Map(owner.state.sources.map((source) => [source.rawId, source]));
    for (const item of offered) {
      const entry = entries.get(item.output.rawId);
      if (
        !entry ||
        entryIdentity(entry) !== item.entryIdentity ||
        item.images.some(
          ({ source }) => JSON.stringify(sources.get(source.rawId)) !== JSON.stringify(source),
        )
      ) {
        throw new NativeContextRuntimeError("conflict", "maintenance-media-source-changed");
      }
    }
  };
  // operationId 只命名这次副本准备请求，不创建 assistant，不 stage/commit 主请求的图片回执。
  const request: NativeContextImagesRequest = {
    messages: input.messages,
    model: input.model,
    assistantMessageId: input.operationId,
    traceContext: input.safePoint.traceContext,
    signal: input.safePoint.signal,
    comparison,
  };
  const policy = comparison.policy.parameters.images,
    limits = nativeImageLimits(request);
  if (
    policy.targetRawKiB !== "auto" &&
    policy.targetRawKiB * 1024 >
      Math.min(limits.maxRawBytes, Math.floor(limits.maxBase64Bytes / 4) * 3)
  )
    throw mediaError("capacity");
  const originalContent = input.messages[userIndex].content;
  const content: ModelMessageContentBlock[] =
    typeof originalContent === "string"
      ? [{ type: "text", text: originalContent }]
      : [...originalContent];
  const projectCurrentMessages = (): ModelInputMessage[] => {
    const messages = input.messages.map((message, index) =>
      index === userIndex ? { ...message, content } : message,
    );
    const projected = projectMessagesForMediaBudget(messages, {
      latestRealUserMessageIndex: userIndex,
    });
    if (projected.omittedMediaCount) throw mediaError("capacity");
    return projected.messages;
  };
  let preparedMessages = input.messages;
  let stage: MediaFailure = "source";
  try {
    await assertCurrent();
    for (const item of offered) {
      stage = "source";
      await assertStoredOutput(owner, item);
      await assertCurrent();
      for (const { block, source } of item.images) {
        stage = "source";
        const owned = await ownedNativeImage(owner, source, input.safePoint.signal);
        await assertCurrent();
        if (!owned) throw mediaError("source");
        const binding = {
          block: {
            ...block,
            mediaType: owned.original.mediaType,
            source: {
              id: source.partId!,
              kind: "resource" as const,
              canonicalPartId: source.partId!,
              uri: owned.original.artifactUri,
              originalImage: structuredClone(owned.original),
            },
          },
          source,
          original: owned.original,
          // adapter 即使原地操作输入也只能影响副本，不能损坏不可变 artifact 的读取缓冲。
          bytes: Uint8Array.from(owned.bytes),
        };
        stage = "unsupported";
        const representation = await nativePrepareImageRepresentation(
          runtime,
          request,
          binding,
          policy,
          limits,
          nativeImagePolicyHash(request, policy, limits, source.sourceKind, block.detail),
          true,
        );
        await assertCurrent();
        content.push(
          {
            type: "text",
            text:
              "[Native context maintenance image " +
              JSON.stringify({ outputRef: item.output.ref, imageRef: source.ref }) +
              "]",
          },
          representation.block,
        );
        if (representation.annotation)
          content.push({ type: "text", text: representation.annotation });
        stage = "capacity";
        // 同一 gate 逐图执行；达到聚合上限即停止后续读取，不能先堆入两百张大图再拒绝。
        preparedMessages = projectCurrentMessages();
      }
    }
    await assertCurrent();
    if (
      historyVersionOf(runtime.messageHistory.borrowReadOnlyRuntimeEntries()) !==
      comparison.historyVersion
    )
      throw new NativeContextRuntimeError("conflict", "maintenance-media-history-changed");
    return preparedMessages;
  } catch (error) {
    if (input.safePoint.signal?.aborted) throw stoppedError(error);
    if (error instanceof NativeContextRuntimeError) {
      if (error.code === "conflict" || error.reason.startsWith("maintenance-media-")) throw error;
      throw mediaError("source", error);
    }
    if (isImageProcessorPortError(error))
      throw mediaError(
        error.code === "too_large" || error.code === "invalid_request" ? "capacity" : "unsupported",
        error,
      );
    throw mediaError(stage, error);
  }
}
