import { createHash } from "node:crypto";
import { ServiceChannels } from "@zcode/shared";
import {
  nativeContextReadImageToolSchema,
  type NativeContextConfiguration,
  type NativeContextStatus,
} from "@zcode/shared/native-context-compression";
import { v4ConversationRowsRangeResultSchema } from "@zcode/shared/zcode-protocol-v4";
import { TID_CHAT_ERROR_BANNER } from "@zcode/shared/test-ids";
import { readModelProvider } from "../desktop-app.js";
import {
  getUpstreamRequestEvidence,
  getUpstreamRequestRecordCount,
} from "../conversation-session-network.js";
import { callHandoffHost } from "../remote-project-handoff-probe.js";
import {
  selectRegistryProviderModelById,
  UPSTREAM_PROVIDER_ID,
  UPSTREAM_PROVIDER_NAME,
} from "../upstream-provider.js";
import {
  getV4ComposerText,
  sendV4Prompt,
  setV4ComposerText,
  waitForV4ConversationState,
} from "../v4-conversation.js";
import { runNativeContextCleanup, withNativeContextCleanup } from "./cleanup.js";
import { readNativeContextComposerModel, restoreNativeContextComposerModel } from "./model.js";
import { createNativeContextPngFixture, type NativeContextPngFixture } from "./fixture.js";
import {
  nativeContextWireImages,
  sendNativeContextImage,
  type NativeContextImageEvidence,
} from "./images.js";
import {
  getNativeContextStatus,
  listNativeContextObservations,
  listNativeContextRecords,
  nativeContextCurrentTarget,
  readNativeContextOriginalImage,
  readNativeContextRecord,
  type NativeContextTestTarget,
} from "./queries.js";
import {
  buildNativeContextImageNegativePrompt,
  nativeContextImageNegativeReplayRef,
  NATIVE_CONTEXT_IMAGE_CAPACITY_SOURCE,
  NATIVE_CONTEXT_IMAGE_NEGATIVE_CASES,
  type NativeContextImageNegativeKind,
} from "./replay-image-negative.js";
import {
  chooseNativeContextOption,
  closeNativeContextDetails,
  openNativeContextDetails,
  saveNativeContextConfiguration,
} from "./ui.js";

export {
  assertNativeContextImageFailureFollowup,
  NativeContextImageFollowupError,
  type NativeContextImageFollowupEvidence,
} from "./image-negative-followup.js";

export interface NativeContextImageNegativeEvidence {
  target: NativeContextTestTarget;
  kind: NativeContextImageNegativeKind;
  originalRef: string;
  originalSha256: string;
  originalBytes: number;
  operationId: string;
  toolCallId: string;
  toolRowId: number;
  inputRowId: number;
  model: { providerId: string; modelId: string };
  errorCode: string;
  providerFixtureIds: string[];
  followupAvailability: "unverified";
}
export interface NativeContextNegativeModel {
  modelId: string;
  providerId?: string;
  providerName?: string;
}

async function ledger(target: NativeContextTestTarget, status: NativeContextStatus) {
  const observations = await listNativeContextObservations(target, status, { limit: 200 });
  const records = await listNativeContextRecords(target, status, { limit: 200 });
  for (const page of [observations, records])
    if (
      page.nextCursor !== null ||
      page.revision !== status.revision ||
      page.generation !== status.generation ||
      page.historyVersion !== status.historyVersion
    )
      throw new Error("NCTX negative-image requires a complete same-version short ledger");
  return { observations: observations.items, records: records.items };
}

async function saveConfiguration(configuration: NativeContextConfiguration) {
  await openNativeContextDetails("parameters");
  await chooseNativeContextOption("scope", 0);
  await saveNativeContextConfiguration(configuration);
  await closeNativeContextDetails();
}

async function rejectedImageRoundtrip(
  evidence: NativeContextImageEvidence,
  original: NativeContextPngFixture,
  kind: NativeContextImageNegativeKind,
  model: { providerId: string; modelId: string },
): Promise<NativeContextImageNegativeEvidence> {
  const target = await nativeContextCurrentTarget();
  expect(target).toEqual(evidence.target);
  expect(evidence.originalRefs).toHaveLength(1);
  expect(evidence.originalSha256).toBe(original.sha256);
  const ref = nativeContextReadImageToolSchema.parse({ ref: evidence.originalRefs[0] }).ref;
  await waitForV4ConversationState(
    (state) =>
      state.sessionId === target.sessionId && state.state === "idle" && state.queueCount === 0,
    "NCTX image negative requires the same settled existing CLI owner",
  );
  const before = await getNativeContextStatus(target);
  const previous = await ledger(target, before);
  const detail = await readNativeContextRecord(target, before, evidence.operationId, {
    sourceLimit: 100,
  });
  const source = detail.sources.find((item) => item.ref === ref);
  if (!source || source.kind !== "image" || !source.originalAvailable || !source.partId)
    throw new Error("NCTX image negative requires a real owned immutable original");
  const fixture = NATIVE_CONTEXT_IMAGE_NEGATIVE_CASES[kind];
  const afterIndex = (await getUpstreamRequestRecordCount()) - 1;
  await sendV4Prompt(buildNativeContextImageNegativePrompt(ref, kind));
  await browser.waitUntil(
    async () => {
      const requests = await getUpstreamRequestEvidence(
        { includes: [fixture.marker + ":"] },
        { afterIndex },
      );
      return requests.some(
        (item) => item.fixtureId === fixture.fixtureId && item.status === "complete",
      );
    },
    {
      timeout: 90000,
      timeoutMsg: "NCTX image negative never completed its real Provider tool_use",
    },
  );
  const banner = $(`[data-testid="${TID_CHAT_ERROR_BANNER}"]`);
  await banner.waitForDisplayed({ timeout: 30000 });
  const feedback =
    kind === "unsupported"
      ? /model-image-capability|image.*(?:unsupported|capability)|不支持.*图片|图片.*不支持/iu
      : /exact image.*hard image budget|original-image-capacity|too_large|capacity|图片.*(?:容量|预算|超限|限制)/iu;
  await browser.waitUntil(async () => feedback.test(await banner.getText()), {
    timeout: 20000,
    timeoutMsg: "NCTX original-image rejection has no explicit capability/capacity feedback",
  });
  const errorCode = await banner.getAttribute("data-error-code");
  expect(errorCode).toBeTruthy();
  await waitForV4ConversationState(
    (state) =>
      state.sessionId === target.sessionId && state.state === "idle" && state.queueCount === 0,
    "NCTX image negative did not settle its failed turn on the same owner",
  );
  const rows = v4ConversationRowsRangeResultSchema.parse(
    await callHandoffHost(ServiceChannels.ZCodeAgent, "conversationRowsRangeV4", [
      { ...target, limit: 200, residency: "resident-only" },
    ]),
  ).rows;
  const calls = rows.filter(
    (row) => row.kind === "toolCall" && row.toolCallId === fixture.toolCallId,
  );
  expect(calls).toHaveLength(1);
  const tool = calls[0]!;
  if (tool.kind !== "toolCall")
    throw new Error("NCTX image negative has no actual ToolPart projection");
  expect(tool.toolName).toBe("context_read_image");
  expect(nativeContextReadImageToolSchema.parse(tool.input ?? JSON.parse(tool.inputText))).toEqual({
    ref,
  });
  // 工具已成功读取，拒绝发生在下一模型请求的最终gate；不能伪装成未执行工具。
  expect(tool.status).toBe("success");
  expect(tool.endedAt).toBeDefined();
  // 通用图片摘要只显示 MIME；ref 归属由严格输入、同 turn ToolPart 与后续 restore 来源/原字节证明。
  expect(tool.output?.text).toBeTruthy();
  const input = rows.findLast(
    (row) => row.kind === "userInput" && row.text.includes(fixture.marker + ":"),
  );
  if (!input || input.kind !== "userInput")
    throw new Error("NCTX image negative lost the actual user input");
  expect(tool.turnId).toBe(input.turnId);
  expect(tool.rowId).toBeGreaterThan(input.rowId);
  const after = await getNativeContextStatus(target);
  expect(after.phase).toBe("idle");
  expect(after.policy).toEqual(before.policy);
  expect(after.generation).toBe(before.generation);
  expect(after.effectiveBlocks).toBe(before.effectiveBlocks);
  const current = await ledger(target, after);
  const oldIds = new Set(previous.observations.map((item) => item.id));
  for (const old of previous.observations)
    expect(current.observations.find((item) => item.id === old.id)).toEqual(old);
  const observations = current.observations.filter((item) => !oldIds.has(item.id));
  expect(observations).toHaveLength(1);
  expect(observations[0]!.purpose).toBe("main");
  expect(observations[0]!.status).toBe("completed");
  expect(observations[0]!.model).toEqual(model);
  expect(observations[0]!.actualInputTokens).toBe(fixture.inputTokens);
  expect(observations[0]!.images.restoredCount).toBe(0);
  const oldOperations = new Set(previous.records.map((item) => item.operationId));
  const operations = current.records.filter((item) => !oldOperations.has(item.operationId));
  expect(
    operations.filter((item) => item.kind === "summary" || item.kind === "decision"),
  ).toHaveLength(0);
  const restores = operations.filter((item) => item.kind === "restore-image");
  expect(restores).toHaveLength(1);
  const restore = await readNativeContextRecord(target, after, restores[0]!.operationId, {
    sourceLimit: 100,
  });
  expect(restore.status).toBe("completed");
  expect(restore.trigger).toBe("model");
  expect(restore.model).toBeNull();
  expect(restore.observationIds).toHaveLength(0);
  expect(restore.blockIds).toHaveLength(0);
  expect(restore.sources).toEqual([source]);
  // UI查询仍可读原图，但不会变成成功发送证明，亦不允许再缩原bytes。
  const stored = await readNativeContextOriginalImage(target, after, ref);
  expect(stored.bytes.equals(original.bytes)).toBe(true);
  expect(stored.sha256).toBe(original.sha256);
  expect(createHash("sha256").update(stored.bytes).digest("hex")).toBe(original.sha256);
  const requests = await getUpstreamRequestEvidence(
    { includes: [fixture.marker + ":"] },
    { afterIndex },
  );
  expect(requests).toHaveLength(1);
  expect(requests[0]!.fixtureId).toBe(fixture.fixtureId);
  expect(requests[0]!.statusCode).toBe(200);
  expect(nativeContextImageNegativeReplayRef(requests[0]!.requestJson, fixture.fixtureId)).toBe(
    ref,
  );
  expect((requests[0]!.requestJson as { model?: string }).model).toBe(model.modelId);
  const sent = nativeContextWireImages(requests[0]!.requestJson);
  if (kind === "unsupported") expect(sent).toHaveLength(0);
  expect(sent.some((item) => item.bytes.equals(original.bytes))).toBe(false);
  return {
    target,
    kind,
    originalRef: ref,
    originalSha256: original.sha256,
    originalBytes: original.bytes.length,
    operationId: restore.operationId,
    toolCallId: fixture.toolCallId,
    toolRowId: tool.rowId,
    inputRowId: input.rowId,
    model,
    errorCode: errorCode!,
    providerFixtureIds: requests.map((item) => item.fixtureId!),
    followupAvailability: "unverified",
  };
}

async function withNegativeImageConfiguration<T>(
  longestEdge: number,
  action: (target: NativeContextTestTarget) => Promise<T>,
) {
  const target = await nativeContextCurrentTarget();
  const before = await getNativeContextStatus(target);
  const original: NativeContextConfiguration = {
    schemaVersion: 1,
    mode: before.policy.mode,
    parameters: structuredClone(before.policy.parameters),
  };
  const candidate = structuredClone(original);
  candidate.mode = "auto";
  Object.assign(candidate.parameters.trigger, {
    start: { kind: "percent", value: 90 },
    target: { kind: "percent", value: 70 },
    opportunisticPercent: 0,
    periodicCheckRounds: 0,
    modelDecides: false,
  });
  Object.assign(candidate.parameters.images, {
    rescale: true,
    maxEdge: Math.min(600, Math.floor(longestEdge / 2)),
    pngMode: "preserve",
    omitSeen: false,
    foldWithHistory: false,
  });
  candidate.parameters.images.minEdge = Math.min(
    candidate.parameters.images.minEdge,
    candidate.parameters.images.maxEdge,
  );
  const draft = (await getV4ComposerText()) ?? "";
  return withNativeContextCleanup(
    async () => {
      await saveConfiguration(candidate);
      return action(target);
    },
    () =>
      runNativeContextCleanup(
        () => saveConfiguration(original),
        () => closeNativeContextDetails(),
        () => setV4ComposerText(draft),
      ),
  );
}

/** 同Provider已配置的真实text-only模型；不新增Provider、不写UI投影、不清失败restore intent。 */
export async function assertNativeContextReadImageUnsupported(
  evidence: NativeContextImageEvidence,
  original: NativeContextPngFixture,
  selection: NativeContextNegativeModel = { modelId: "E2E_NCTX_TEXT_ONLY" },
) {
  const providerId = selection.providerId ?? UPSTREAM_PROVIDER_ID;
  const provider = await readModelProvider(providerId);
  const selected = provider?.models.find((model) => model.id === selection.modelId);
  if (!selected || selected.modalities.input.includes("image") || !selected.supportsTools)
    throw new Error("NCTX unsupported requires a configured text-only tool-capable real model");
  const target = await nativeContextCurrentTarget();
  const initialSelection = await readNativeContextComposerModel(target);
  return withNativeContextCleanup(
    () =>
      withNegativeImageConfiguration(Math.max(original.width, original.height), async () => {
        await selectRegistryProviderModelById(selection.modelId, {
          providerId,
          providerName: selection.providerName ?? provider?.name ?? UPSTREAM_PROVIDER_NAME,
          includePlainModelFallback: false,
        });
        return rejectedImageRoundtrip(evidence, original, "unsupported", {
          providerId,
          modelId: selection.modelId,
        });
      }),
    () => restoreNativeContextComposerModel(target, initialSelection),
  );
}

/** 固定真实hard budget，不捏造模型小限制。容量场景建议最后运行；后续可用性需另行验收。 */
export async function assertNativeContextReadImageCapacity(
  original = createNativeContextPngFixture(1500, 1000),
) {
  // 当前contracts/read.ts：5MiB base64、对应3.75MiB raw、2000px；fixture只超字节，不超边长。
  const maxBase64Bytes = 5 * 1024 * 1024;
  expect(original.bytes.length).toBeGreaterThan(Math.floor((maxBase64Bytes * 3) / 4));
  expect(Math.ceil(original.bytes.length / 3) * 4).toBeGreaterThan(maxBase64Bytes);
  expect(Math.max(original.width, original.height)).toBeLessThanOrEqual(2000);
  return withNegativeImageConfiguration(
    Math.max(original.width, original.height),
    async (target) => {
      const model = await readNativeContextComposerModel(target);
      const provider = await readModelProvider(model.providerId);
      expect(
        provider?.models.find((item) => item.id === model.modelId)?.modalities.input,
      ).toContain("image");
      const fixture = NATIVE_CONTEXT_IMAGE_CAPACITY_SOURCE;
      const evidence = await sendNativeContextImage(
        fixture.marker,
        fixture.fixtureId,
        original,
        1,
        fixture.inputTokens,
      );
      return rejectedImageRoundtrip(evidence, original, "capacity", {
        providerId: model.providerId,
        modelId: model.modelId,
      });
    },
  );
}
