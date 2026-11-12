import { createHash } from "node:crypto";
import {
  nativeContextReadImageToolSchema,
  type NativeContextObservation,
  type NativeContextStatus,
} from "@zcode/shared/native-context-compression";
import {
  getUpstreamRequestEvidence,
  getUpstreamRequestRecordCount,
  type UpstreamRequestEvidence,
} from "../conversation-session-network.js";
import { sendV4Prompt, waitForV4ConversationState } from "../v4-conversation.js";
import {
  nativePngHasTransparentPixel,
  readNativePngDimensions,
  type NativeContextPngFixture,
} from "./fixture.js";
import {
  nativeContextLatestUploadImages,
  nativeContextWireImages,
  type NativeContextImageEvidence,
} from "./images.js";
import {
  getNativeContextStatus,
  listNativeContextObservations,
  listNativeContextRecords,
  nativeContextCurrentTarget,
  readNativeContextRecord,
  type NativeContextTestTarget,
} from "./queries.js";
import {
  buildNativeContextReadImagePrompt,
  nativeContextReadImageReplayRef,
  NATIVE_CONTEXT_READ_IMAGE_MARKER,
  NATIVE_CONTEXT_READ_IMAGE_REPLAY,
} from "./replay-read-image.js";
import { closeNativeContextDetails } from "./ui.js";

export interface NativeContextReadImageEvidence {
  target: NativeContextTestTarget;
  originalRef: string;
  originalPartId: string;
  originalSha256: string;
  originalBytes: number;
  toolCallId: string;
  operationId: string;
  observations: NativeContextObservation[];
  providerFixtureIds: string[];
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function ledger(target: NativeContextTestTarget, status: NativeContextStatus) {
  const observations = await listNativeContextObservations(target, status, {
    limit: 200,
  });
  const records = await listNativeContextRecords(target, status, {
    limit: 200,
  });
  for (const page of [observations, records]) {
    if (
      page.nextCursor !== null ||
      page.revision !== status.revision ||
      page.generation !== status.generation ||
      page.historyVersion !== status.historyVersion
    )
      throw new Error(
        "NCTX read-image ledger requires a complete, version-matched short-history page",
      );
  }
  return { observations: observations.items, records: records.items };
}

function originalToolResult(request: unknown, ref: string) {
  if (!object(request) || !Array.isArray(request.messages))
    throw new Error("NCTX read-image provider request has no message array");
  const calls: Array<{ messageIndex: number; part: Record<string, unknown> }> = [];
  const results: Array<{
    messageIndex: number;
    part: Record<string, unknown>;
  }> = [];
  for (const [messageIndex, message] of request.messages.entries()) {
    if (!object(message) || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!object(part)) continue;
      if (
        message.role === "assistant" &&
        part.type === "tool_use" &&
        part.id === NATIVE_CONTEXT_READ_IMAGE_REPLAY.toolCallId
      )
        calls.push({ messageIndex, part });
      if (
        message.role === "user" &&
        part.type === "tool_result" &&
        part.tool_use_id === NATIVE_CONTEXT_READ_IMAGE_REPLAY.toolCallId
      )
        results.push({ messageIndex, part });
    }
  }
  expect(calls).toHaveLength(1);
  expect(results).toHaveLength(1);
  expect(calls[0]!.part.name).toBe("context_read_image");
  expect(nativeContextReadImageToolSchema.parse(calls[0]!.part.input)).toEqual({
    ref,
  });
  expect(results[0]!.messageIndex).toBeGreaterThan(calls[0]!.messageIndex);
  expect(results[0]!.part.is_error).not.toBe(true);
  return results[0]!.part.content;
}

async function toolRequests(afterIndex: number): Promise<UpstreamRequestEvidence[]> {
  let requests: UpstreamRequestEvidence[] = [];
  await browser.waitUntil(
    async () => {
      requests = await getUpstreamRequestEvidence(
        { includes: [NATIVE_CONTEXT_READ_IMAGE_MARKER] },
        { afterIndex },
      );
      return requests.some(
        (request) =>
          request.fixtureId === NATIVE_CONTEXT_READ_IMAGE_REPLAY.resultFixtureId &&
          request.status === "complete",
      );
    },
    {
      timeout: 90000,
      timeoutMsg: "NCTX context_read_image did not complete its real tool/model roundtrip",
    },
  );
  expect(requests.map((request) => request.fixtureId)).toEqual([
    NATIVE_CONTEXT_READ_IMAGE_REPLAY.toolFixtureId,
    NATIVE_CONTEXT_READ_IMAGE_REPLAY.resultFixtureId,
  ]);
  expect(
    requests.every((request) => request.status === "complete" && request.statusCode === 200),
  ).toBe(true);
  return requests;
}

/** Provider tool → same CLI ToolPart → next main request → original PNG → owner usage/operation. */
export async function assertNativeContextReadImage(
  evidence: NativeContextImageEvidence,
  original: NativeContextPngFixture,
  sourceMarker = "E2E_NCTX_IMAGE_OPAQUE",
): Promise<NativeContextReadImageEvidence> {
  const target = await nativeContextCurrentTarget();
  expect(target).toEqual(evidence.target);
  expect(evidence.originalRefs).toHaveLength(1);
  expect(evidence.observation.status).toBe("completed");
  expect(evidence.originalSha256).toBe(original.sha256);
  expect(evidence.sourceBytes).toBe(original.bytes.length);
  expect(sha256(original.bytes)).toBe(original.sha256);
  const ref = nativeContextReadImageToolSchema.parse({
    ref: evidence.originalRefs[0],
  }).ref;
  await closeNativeContextDetails();
  await waitForV4ConversationState(
    (state) =>
      state.sessionId === target.sessionId && state.state === "idle" && state.queueCount === 0,
    "NCTX read-image requires the same settled, admitted CLI session",
  );
  const before = await getNativeContextStatus(target);
  expect(before.phase).toBe("idle");
  // 验收依据：保持实际降采样策略开启，才能证明原图工具豁免真实绕过本次编码。
  expect(before.policy.mode).toBe("auto");
  expect(before.policy.parameters.images.rescale).toBe(true);
  expect(before.policy.parameters.images.maxEdge).toBeLessThan(
    Math.max(original.width, original.height),
  );
  const sourceDetail = await readNativeContextRecord(target, before, evidence.operationId, {
    sourceLimit: 100,
  });
  const source = sourceDetail.sources.find((item) => item.ref === ref);
  if (!source || source.kind !== "image" || !source.originalAvailable || !source.partId)
    throw new Error("NCTX read-image requires an owned immutable original image part");
  expect(source.messageId).toBe(evidence.sourceMessageId);
  const prior = await ledger(target, before);
  // afterIndex 是排他的数组索引；请求总数 N 对应的边界必须是 N-1。
  const afterIndex = (await getUpstreamRequestRecordCount()) - 1;
  await sendV4Prompt(buildNativeContextReadImagePrompt(ref));
  const requests = await toolRequests(afterIndex);
  expect(nativeContextReadImageReplayRef(requests[0]!.requestJson)).toBe(ref);
  const resumeRequest = requests[1]!.requestJson;
  const restored = nativeContextWireImages(originalToolResult(resumeRequest, ref));
  expect(restored).toHaveLength(1);
  expect(restored[0]!.mediaType).toBe("image/png");
  expect(restored[0]!.bytes.equals(original.bytes)).toBe(true);
  expect(sha256(restored[0]!.bytes)).toBe(original.sha256);
  // 尺寸解析已包含 alphaChannel；分别核对原尺寸和真实透明度，避免对象增字段误报。
  const { width, height, alphaChannel } = readNativePngDimensions(restored[0]!.bytes);
  expect({ width, height }).toEqual({
    width: original.width,
    height: original.height,
  });
  expect(alphaChannel).toBe(readNativePngDimensions(original.bytes).alphaChannel);
  expect(nativePngHasTransparentPixel(restored[0]!.bytes)).toBe(original.alpha);
  const previousCopies = nativeContextLatestUploadImages(requests[0]!.requestJson, sourceMarker);
  expect(previousCopies.length).toBeLessThanOrEqual(1);
  expect(previousCopies.every((copy) => sha256(copy.bytes) !== original.sha256)).toBe(true);
  // 同 ref 的旧上传 carrier 必须被替代；不能同时保留旧副本和新的工具原图。
  expect(nativeContextLatestUploadImages(resumeRequest, sourceMarker)).toHaveLength(0);
  const wireImages = nativeContextWireImages(resumeRequest);
  expect(wireImages.filter((image) => sha256(image.bytes) === original.sha256)).toHaveLength(1);
  await waitForV4ConversationState(
    (state) =>
      state.sessionId === target.sessionId && state.state === "idle" && state.queueCount === 0,
    "NCTX read-image did not settle on the existing CLI owner",
    90000,
  );
  let after = await getNativeContextStatus(target);
  await browser.waitUntil(
    async () => {
      after = await getNativeContextStatus(target);
      return (
        after.lastObservation?.status === "completed" &&
        after.lastObservation.actualInputTokens ===
          NATIVE_CONTEXT_READ_IMAGE_REPLAY.resultResponse.text.inputTokens
      );
    },
    {
      timeout: 20000,
      timeoutMsg: "NCTX original-image main request has no completed usage observation",
    },
  );
  expect(after.policy).toEqual(before.policy);
  expect(after.generation).toBe(before.generation);
  expect(after.currentSegmentId).toBe(before.currentSegmentId);
  expect(after.effectiveBlocks).toBe(before.effectiveBlocks);
  const current = await ledger(target, after);
  const oldIds = new Set(prior.observations.map((item) => item.id));
  for (const previous of prior.observations)
    expect(current.observations.find((item) => item.id === previous.id)).toEqual(previous);
  const observations = current.observations
    .filter((item) => !oldIds.has(item.id))
    .sort((a, b) => a.requestSeq - b.requestSeq);
  expect(observations).toHaveLength(2);
  expect(observations.every((item) => item.purpose === "main" && item.status === "completed")).toBe(
    true,
  );
  const [call, resume] = observations;
  expect(call!.actualInputTokens).toBe(
    NATIVE_CONTEXT_READ_IMAGE_REPLAY.toolResponse.toolUse.inputTokens,
  );
  expect(resume!.actualInputTokens).toBe(
    NATIVE_CONTEXT_READ_IMAGE_REPLAY.resultResponse.text.inputTokens,
  );
  expect(call!.images.restoredCount).toBe(0);
  expect(resume!.images.restoredCount).toBe(1);
  expect(resume!.images.afterBytes).toBe(
    wireImages.reduce((sum, image) => sum + image.bytes.length, 0),
  );
  expect(resume!.images.sentCount).toBe(wireImages.length);
  expect(resume!.anchorMessageId).toBeTruthy();
  expect(call!.anchorMessageId).toBeTruthy();
  expect(resume!.anchorMessageId).not.toBe(source.messageId);
  expect(resume!.model).toEqual(call!.model);
  const oldOperations = new Set(prior.records.map((item) => item.operationId));
  const operations = current.records.filter((item) => !oldOperations.has(item.operationId));
  expect(
    operations.filter((item) => item.kind === "summary" || item.kind === "decision"),
  ).toHaveLength(0);
  const restores = operations.filter((item) => item.kind === "restore-image");
  expect(restores).toHaveLength(1);
  const operation = await readNativeContextRecord(target, after, restores[0]!.operationId, {
    sourceLimit: 100,
  });
  expect(operation.status).toBe("completed");
  expect(operation.trigger).toBe("model");
  expect(operation.model).toBeNull();
  expect(operation.observationIds).toHaveLength(0);
  expect(operation.blockIds).toHaveLength(0);
  expect(operation.sources).toEqual([source]);
  expect(resume!.operationIds).toContain(operation.operationId);
  return {
    target,
    originalRef: ref,
    originalPartId: source.partId,
    originalSha256: original.sha256,
    originalBytes: original.bytes.length,
    toolCallId: NATIVE_CONTEXT_READ_IMAGE_REPLAY.toolCallId,
    operationId: operation.operationId,
    observations,
    providerFixtureIds: requests.map((request) => request.fixtureId!),
  };
}
