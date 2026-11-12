import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelTransportKind } from "@zcode/contracts";
import type { NativeContextObservation } from "@zcode/shared/native-context-compression";
import { imageFixture, pngHeaderBytes } from "./native-context-image-fixture.js";
import {
  prepareNativeContextImages,
  commitNativeImageReceipts,
} from "../src/runtime/native-context-compression/images.js";
import type {
  NativeContextImagesRequest,
  NativeContextImagesResult,
} from "../src/runtime/native-context-compression/image-contract.js";
import {
  freezeNativeAttempt,
  prepareNativeAttempt,
  settleNativeAttempt,
} from "../src/runtime/native-context-compression/attempt-facts.js";
import { retainNativeSentImages } from "../src/runtime/native-context-compression/model-request.js";
import { kernelOf } from "../src/runtime/native-context-compression/state.js";

type ImageFixture = ReturnType<typeof imageFixture>;
const LOGICAL_REQUEST = "fixture-logical-request";
function stamp(
  receipts: Awaited<ReturnType<typeof prepareNativeContextImages>>["sentImages"],
  logicalRequestId = LOGICAL_REQUEST,
): void {
  for (const receipt of receipts) receipt.logicalRequestId = logicalRequestId;
}
function seedMainObservation(
  f: ImageFixture,
  input: NativeContextImagesRequest,
  result: NativeContextImagesResult,
  extra: Partial<NativeContextObservation> = {},
): NativeContextObservation {
  const comparison = input.comparison!;
  const frozen = freezeNativeAttempt({
    comparison,
    policy: comparison.policy,
    model: input.model,
    beforeMessages: comparison.baselineMessages,
    afterMessages: result.messages,
    tools: [],
    maxOutputTokens: 4096,
    sentImages: result.sentImages,
    imageChanges: result.imageChanges,
    traceContext: input.traceContext,
    anchorMessageId: input.assistantMessageId,
  });
  const prepared = prepareNativeAttempt(
    frozen,
    {
      type: "model_request_started",
      requestId: extra.logicalRequestId ?? LOGICAL_REQUEST,
      attempt: 1,
      maxAttempts: 1,
      timestamp: new Date(1000).toISOString(),
      traceId: input.traceContext.traceId,
      spanId: input.traceContext.spanId,
      providerId: input.model.providerId,
      modelId: input.model.modelId,
      transport: ModelTransportKind.Sse,
    },
    7,
  );
  return f.seedObservation({
    ...settleNativeAttempt(
      prepared,
      "completed",
      {
        inputTokens: 321,
        outputTokens: 17,
        cacheReadTokens: 0,
      },
      1200,
    ),
    ...extra,
  });
}
function lastImageRecord(f: ImageFixture) {
  const request = f.commitRequests.at(-1);
  assert.ok(request, "the complete receipt transaction must be persisted");
  const records = (request.operations ?? []).filter((record) => record.kind === "image");
  assert.equal(
    records.length,
    1,
    "successful image delivery must persist one image record in its receipt CAS",
  );
  const record = records[0]!;
  assert.equal(record.status, "completed");
  return { request, record };
}
function assertObservationLink(
  f: ImageFixture,
  observation: NativeContextObservation,
  recordId: string,
) {
  const linked = { ...observation, operationIds: [...observation.operationIds, recordId] };
  assert.deepEqual(f.commitRequests.at(-1)!.observations, [linked]);
  assert.deepEqual(f.observations.get(observation.id), linked);
  assert.equal(
    f.observations.size,
    1,
    "image delivery must update the existing physical point rather than append usage",
  );
}
test("prepare stages copies without changing canonical data; complete persisted assistant may append to live history", async () => {
  const f = imageFixture();
  f.addImage("old");
  f.addText("latest");
  const input = f.request(),
    before = structuredClone(f.entries),
    state = structuredClone(f.state);
  const result = await prepareNativeContextImages(f.runtime, input);
  assert.deepEqual(f.entries, before);
  assert.deepEqual(f.state, state);
  assert.equal(f.commits.length, 0);
  assert.equal(result.sentImages.length, 1);
  assert.equal(result.sentImages[0]!.logicalRequestId, "pending");
  assert.deepEqual(Buffer.from(f.calls[0]!.data), pngHeaderBytes());
  assert.equal(f.writes.length, 1);
  stamp(result.sentImages);
  f.complete(input);
  const observation = seedMainObservation(f, input, result, { operationIds: ["prior-summary"] });
  f.runtime.sessionModelSelection = {
    providerId: "composer-provider",
    modelId: "composer-model",
  } as typeof f.runtime.sessionModelSelection;
  await commitNativeImageReceipts(f.runtime, result.sentImages, input.comparison);
  assert.equal(f.commits.length, 1);
  assert.equal(f.state.imageReceipts.length, 1);
  assert.equal(kernelOf(f.state).imageViews?.[result.sentImages[0]!.ref]?.bytes, 1024);
  const { request, record } = lastImageRecord(f);
  assert.deepEqual(request.state.imageReceipts, result.sentImages);
  assert.equal(record.anchorMessageId, input.assistantMessageId);
  assert.equal(record.anchorRequestSeq, observation.requestSeq);
  assert.equal(record.generation, observation.generation);
  assert.equal(record.historyVersion, observation.historyVersion);
  assert.equal(record.policyVersion, observation.policyVersion);
  assert.equal(record.segmentId, observation.segmentId);
  assert.deepEqual(record.model, observation.model);
  assert.equal(record.beforeEstimate, observation.beforeEstimate);
  assert.equal(record.afterEstimate, observation.afterEstimate);
  assert.deepEqual(record.observationIds, [observation.id]);
  const source = f.state.sources.find((item) => item.ref === result.sentImages[0]!.ref)!;
  assert.deepEqual(record.sources, [
    {
      ref: source.ref,
      messageId: source.messageId,
      partId: source.partId,
      imageIndex: source.imageIndex,
      kind: "image",
      originalAvailable: true,
    },
  ]);
  assert.notEqual(record.sources[0]!.messageId, record.anchorMessageId);
  assertObservationLink(f, observation, record.operationId);
  await commitNativeImageReceipts(f.runtime, result.sentImages, input.comparison);
  assert.equal(f.commits.length, 1);
  assert.equal(f.operations.size, 1);
  assertObservationLink(f, observation, record.operationId);
});
for (const [name, options] of [
  ["missing step-finish", { missingFinish: true }],
  ["unfinished assistant", { incomplete: true }],
  ["assistant error", { error: true }],
  ["cancelled completion", { reason: "cancelled" }],
  ["discarded completion", { reason: "discarded" }],
  ["filtered response", { reason: "content_filter" }],
] as const) {
  test(name + " cannot authorize an image receipt or view", async () => {
    const f = imageFixture();
    f.addImage("old");
    f.addText("latest");
    const input = f.request(),
      result = await prepareNativeContextImages(f.runtime, input);
    stamp(result.sentImages);
    const observation = seedMainObservation(f, input, result);
    f.complete(input, options);
    await commitNativeImageReceipts(f.runtime, result.sentImages, input.comparison);
    assert.equal(f.commits.length, 0);
    assert.equal(f.state.imageReceipts.length, 0);
    assert.equal(kernelOf(f.state).imageViews, undefined);
    assert.equal(f.operations.size, 0);
    assert.deepEqual(f.observations.get(observation.id), observation);
  });
}
test("pending network request and stopped attempt cannot submit receipts despite a complete assistant fixture", async () => {
  const f = imageFixture();
  f.addImage("old");
  f.addText("latest");
  const controller = new AbortController(),
    input = f.request({ signal: controller.signal });
  const result = await prepareNativeContextImages(f.runtime, input);
  const observation = seedMainObservation(f, input, result);
  f.complete(input);
  await commitNativeImageReceipts(f.runtime, result.sentImages, input.comparison);
  assert.equal(f.commits.length, 0);
  assert.equal(f.operations.size, 0);
  assert.deepEqual(f.observations.get(observation.id), observation);
  stamp(result.sentImages);
  controller.abort();
  await commitNativeImageReceipts(f.runtime, result.sentImages, input.comparison);
  assert.equal(f.commits.length, 0);
});

for (const mismatch of ["session", "message", "finish-part"] as const) {
  test(
    mismatch + " identity mismatch in persisted response cannot authorize a receipt",
    async () => {
      const f = imageFixture();
      f.addImage("old");
      f.addText("latest");
      const input = f.request();
      const result = await prepareNativeContextImages(f.runtime, input);
      stamp(result.sentImages);
      const observation = seedMainObservation(f, input, result);
      const response = f.complete(input);
      if (mismatch === "session")
        response.info.sessionID = "another-session" as typeof response.info.sessionID;
      if (mismatch === "message") response.info.id = "another-response" as typeof response.info.id;
      if (mismatch === "finish-part")
        response.parts[0]!.messageID = "another-response" as typeof response.info.id;
      await commitNativeImageReceipts(f.runtime, result.sentImages, input.comparison);
      assert.equal(f.commits.length, 0);
      assert.equal(f.state.imageReceipts.length, 0);
      assert.equal(f.operations.size, 0);
      assert.deepEqual(f.observations.get(observation.id), observation);
    },
  );
}
test("CAS rejection leaves owner atomic and permits the same frozen attempt to retry", async () => {
  const f = imageFixture();
  f.addImage("old");
  f.addText("latest");
  const input = f.request(),
    result = await prepareNativeContextImages(f.runtime, input);
  const observation = seedMainObservation(f, input, result),
    before = structuredClone(f.state);
  stamp(result.sentImages);
  f.complete(input);
  f.rejectNextCommit();
  await assert.rejects(
    commitNativeImageReceipts(f.runtime, result.sentImages, input.comparison),
    /CAS rejection/u,
  );
  assert.deepEqual(f.state, before);
  assert.equal(f.commits.length, 0);
  assert.equal(f.operations.size, 0);
  assert.deepEqual(f.observations.get(observation.id), observation);
  await commitNativeImageReceipts(f.runtime, result.sentImages, input.comparison);
  assert.equal(f.commits.length, 1);
  assertObservationLink(f, observation, lastImageRecord(f).record.operationId);
});
test("publish failure after successful CAS remains idempotent", async () => {
  const f = imageFixture();
  f.addImage("old");
  f.addText("latest");
  const input = f.request(),
    result = await prepareNativeContextImages(f.runtime, input);
  stamp(result.sentImages);
  const observation = seedMainObservation(f, input, result);
  f.complete(input);
  f.rejectNextPublish();
  await assert.rejects(
    commitNativeImageReceipts(f.runtime, result.sentImages, input.comparison),
    /publish rejection/u,
  );
  assert.equal(f.state.imageReceipts.length, 1);
  const record = lastImageRecord(f).record;
  assertObservationLink(f, observation, record.operationId);
  await commitNativeImageReceipts(f.runtime, result.sentImages, input.comparison);
  assert.equal(f.commits.length, 1);
  assert.equal(f.state.imageReceipts.length, 1);
  assert.equal(f.operations.size, 1);
  assertObservationLink(f, observation, record.operationId);
});
test("final gate keeps array identity and commits only representations actually sent", async () => {
  const f = imageFixture();
  f.addImage("same-a");
  f.addImage("same-b");
  f.addText("latest");
  const input = f.request(),
    result = await prepareNativeContextImages(f.runtime, input);
  assert.equal(result.sentImages.length, 2);
  assert.notEqual(result.sentImages[0]!.ref, result.sentImages[1]!.ref);
  assert.equal(result.sentImages[0]!.representationHash, result.sentImages[1]!.representationHash);
  const originalArray = result.sentImages;
  const removed = result.sentImages[1]!;
  result.messages = result.messages.map((message) => ({
    ...message,
    content: Array.isArray(message.content)
      ? message.content.filter(
          (block) => block.type !== "image" || block.source?.canonicalPartId !== "same-b-image",
        )
      : message.content,
  }));
  retainNativeSentImages(f.state, result, result.messages);
  assert.equal(result.sentImages, originalArray);
  assert.ok(result.imageChanges.omittedRefs.includes(removed.ref));
  stamp(result.sentImages);
  const observation = seedMainObservation(f, input, result);
  f.complete(input);
  await commitNativeImageReceipts(f.runtime, result.sentImages, input.comparison);
  assert.equal(f.state.imageReceipts.length, 1);
  assert.equal(kernelOf(f.state).imageViews?.[removed.ref], undefined);
  assert.equal(kernelOf(f.state).omittedImageRefs?.includes(removed.ref), false);
  const record = lastImageRecord(f).record;
  assert.deepEqual(
    record.sources.map((source) => source.ref),
    result.sentImages.map((receipt) => receipt.ref),
  );
  assert.equal(
    record.sources.some((source) => source.ref === removed.ref),
    false,
  );
  assertObservationLink(f, observation, record.operationId);
});
test("removing every sent image leaves no view or newly omitted state", async () => {
  const f = imageFixture();
  f.addImage("old");
  f.addText("latest");
  const input = f.request(),
    result = await prepareNativeContextImages(f.runtime, input);
  result.messages = result.messages.map((message) => ({
    ...message,
    content: Array.isArray(message.content)
      ? message.content.filter((block) => block.type !== "image")
      : message.content,
  }));
  retainNativeSentImages(f.state, result, result.messages);
  const observation = seedMainObservation(f, input, result);
  f.complete(input);
  await commitNativeImageReceipts(f.runtime, result.sentImages, input.comparison);
  assert.equal(f.commits.length, 0);
  assert.equal(kernelOf(f.state).imageViews, undefined);
  assert.equal(f.operations.size, 0);
  assert.deepEqual(f.observations.get(observation.id), observation);
});
test("cloned receipt arrays and altered encoding identity are rejected", async () => {
  const f = imageFixture();
  f.addImage("old");
  f.addText("latest");
  const input = f.request(),
    result = await prepareNativeContextImages(f.runtime, input);
  stamp(result.sentImages);
  f.complete(input);
  await assert.rejects(
    commitNativeImageReceipts(f.runtime, [...result.sentImages], input.comparison),
    /image-staging/u,
  );
  result.sentImages[0]!.policyHash = "a".repeat(64);
  await assert.rejects(
    commitNativeImageReceipts(f.runtime, result.sentImages, input.comparison),
    /image-receipt/u,
  );
  assert.equal(f.commits.length, 0);
});
for (const boundary of ["policy", "generation", "segment", "branch-source"] as const) {
  test(boundary + " change rejects frozen staging without a partial owner write", async () => {
    const f = imageFixture();
    f.addImage("old");
    f.addText("latest");
    const input = f.request(),
      result = await prepareNativeContextImages(f.runtime, input);
    stamp(result.sentImages);
    f.complete(input);
    if (boundary === "policy") f.state.policy.policyVersion++;
    if (boundary === "generation") f.runtime.branchGeneration++;
    if (boundary === "segment") f.state.compactBoundaryId = "next-compact";
    if (boundary === "branch-source") f.entries.splice(0, 1);
    await assert.rejects(
      commitNativeImageReceipts(f.runtime, result.sentImages, input.comparison),
      /image-boundary|image-branch-source/u,
    );
    assert.equal(f.commits.length, 0);
    assert.equal(f.state.imageReceipts.length, 0);
  });
}
test("missing persisted original provenance never creates a recoverable image receipt", async () => {
  const f = imageFixture();
  const image = f.addImage("old");
  f.addText("latest");
  const part = f.messages.get("old")!.parts[0]!;
  assert.equal(part.type, "file");
  if (part.type === "file") delete part.metadata;
  const input = f.request(),
    result = await prepareNativeContextImages(f.runtime, input);
  assert.equal(result.sentImages.length, 0);
  assert.equal(f.calls.length, 0);
  const sent = result.messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .find((block) => block.type === "image");
  assert.equal(sent?.type === "image" ? sent.dataUrl : null, image.dataUrl);
});

test("complete image delivery still records real sources when its main usage observation is unavailable", async () => {
  const f = imageFixture();
  f.addImage("old");
  f.addText("latest");
  const input = f.request(),
    result = await prepareNativeContextImages(f.runtime, input);
  stamp(result.sentImages);
  f.complete(input);
  await commitNativeImageReceipts(f.runtime, result.sentImages, input.comparison);
  assert.equal(f.state.imageReceipts.length, 1);
  const { request, record } = lastImageRecord(f);
  assert.equal(record.anchorMessageId, input.assistantMessageId);
  assert.deepEqual(
    record.sources.map((source) => source.ref),
    [result.sentImages[0]!.ref],
  );
  assert.deepEqual(record.observationIds, []);
  assert.equal(record.beforeEstimate, null);
  assert.equal(record.afterEstimate, null);
  assert.equal(record.anchorRequestSeq ?? null, null);
  assert.deepEqual(request.observations ?? [], []);
  assert.equal(f.observations.size, 0);
  assert.equal(f.owner.lastObservation, null);
  await commitNativeImageReceipts(f.runtime, result.sentImages, input.comparison);
  assert.equal(f.operations.size, 1);
  assert.equal(f.commits.length, 1);
});

for (const [name, extra] of [
  ["different assistant", { anchorMessageId: "another-response" }],
  ["different physical request", { logicalRequestId: "another-physical-request" }],
  ["prepared request", { status: "prepared", completedAt: null }],
  ["failed request", { status: "error" }],
  ["maintenance purpose", { purpose: "maintenance" }],
  ["different generation", { generation: 1 }],
  ["different policy", { policyVersion: 1 }],
  ["different compact segment", { segmentId: "another-segment" }],
] as const) {
  test(
    name + " observation is not linked or rewritten by a real image delivery record",
    async () => {
      const f = imageFixture();
      f.addImage("old");
      f.addText("latest");
      const input = f.request(),
        result = await prepareNativeContextImages(f.runtime, input);
      stamp(result.sentImages);
      const observation = seedMainObservation(f, input, result, extra);
      f.complete(input);
      await commitNativeImageReceipts(f.runtime, result.sentImages, input.comparison);
      assert.equal(f.state.imageReceipts.length, 1);
      const { request, record } = lastImageRecord(f);
      assert.deepEqual(record.observationIds, []);
      assert.equal(record.beforeEstimate, null);
      assert.equal(record.afterEstimate, null);
      assert.deepEqual(request.observations ?? [], []);
      assert.deepEqual(f.observations.get(observation.id), observation);
      assert.deepEqual(f.owner.lastObservation, observation);
      assert.equal(f.observations.size, 1);
    },
  );
}

test("a successfully qualified omission gets its own image record without inventing another send receipt", async () => {
  const f = imageFixture();
  Object.assign(f.state.policy.parameters.images, {
    omitSeen: true,
    foldWithHistory: false,
    keepRecentUserTurns: 1,
  });
  f.addImage("old");
  f.addText("latest");
  const firstInput = f.request(),
    first = await prepareNativeContextImages(f.runtime, firstInput);
  stamp(first.sentImages);
  seedMainObservation(f, firstInput, first);
  f.complete(firstInput);
  await commitNativeImageReceipts(f.runtime, first.sentImages, firstInput.comparison);
  const firstReceipt = structuredClone(f.state.imageReceipts[0]!);
  const input = f.request(),
    result = await prepareNativeContextImages(f.runtime, input);
  assert.equal(result.sentImages.length, 0);
  assert.deepEqual(result.imageChanges.omittedRefs, [firstReceipt.ref]);
  const observation = seedMainObservation(f, input, result, {
    logicalRequestId: "omitted-physical-request",
    requestSeq: 8,
  });
  f.complete(input);
  await commitNativeImageReceipts(f.runtime, result.sentImages, input.comparison);
  const { request, record } = lastImageRecord(f);
  assert.equal(record.anchorMessageId, input.assistantMessageId);
  assert.equal(record.anchorRequestSeq, observation.requestSeq);
  assert.deepEqual(
    record.sources.map((source) => source.ref),
    [firstReceipt.ref],
  );
  assert.deepEqual(record.observationIds, [observation.id]);
  const linked = { ...observation, operationIds: [record.operationId] };
  assert.deepEqual(request.observations, [linked]);
  assert.deepEqual(f.observations.get(observation.id), linked);
  assert.deepEqual(request.state.imageReceipts, [firstReceipt]);
  assert.deepEqual(f.state.imageReceipts, [firstReceipt]);
  assert.deepEqual(kernelOf(f.state).omittedImageRefs, [firstReceipt.ref]);
  assert.equal(f.operations.size, 2);
  assert.equal(f.observations.size, 2);
  await commitNativeImageReceipts(f.runtime, result.sentImages, input.comparison);
  assert.equal(f.commits.length, 2);
  assert.equal(f.operations.size, 2);
});
