import assert from "node:assert/strict";
import test from "node:test";
import { createMessageId, type Model, type ModelInputMessage } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import type { RunModelTextRequestOptions } from "../src/runtime/types.js";
import {
  initialNativeState,
  nativeOwner,
} from "../src/runtime/native-context-compression/state.js";
import {
  nativeModelBaseline,
  retainNativeSentImages,
  prepareNativeModelRequest,
} from "../src/runtime/native-context-compression/model-request.js";
import type { NativeContextImagesResult } from "../src/runtime/native-context-compression/image-contract.js";

const model = {
  providerId: "fixture",
  modelId: "vision",
  properties: {
    contextWindow: 100_000,
    inputFormat: { supportsImage: true, supportsPdf: false, supportsVideo: false },
  },
  optionSpecs: { maxOutputTokens: { max: 1000 } },
} as Model;
const image = (partId: string): ModelInputMessage => ({
  role: "user",
  content: [
    {
      type: "image",
      mediaType: "image/png",
      dataUrl: "data:image/png;base64,YQ==",
      source: { id: partId, kind: "resource", canonicalPartId: partId },
    },
  ],
});
function fixture() {
  const runtime = {
    config: {},
    branchGeneration: 0,
    sessionPersisted: true,
    sessionId: "fixture",
    rootTraceContext: { traceId: "fixture", spanId: "fixture" },
    messageHistory: { borrowReadOnlyRuntimeEntries: () => [] },
    sessionStore: { commitNativeContext: async () => {} },
    registry: { list: () => [] },
  } as unknown as AgentRuntimeInternal;
  const state = initialNativeState(runtime);
  nativeOwner(runtime).state = state;
  state.sources = ["first", "second"].map((id, index) => ({
    ref: id,
    rawId: id + "#e0:image0",
    kind: "image",
    sourceKind: "attachment",
    messageId: id,
    partId: id,
    entryIndex: 0,
    imageIndex: 0,
    contentHash: "1".repeat(64),
    originalAvailable: false,
    firstSeenAt: 1,
    tokenSnapshot: 0,
    artifactUri: null,
    originalBytes: null,
    mediaType: "image/png",
    width: null,
    height: null,
  }));
  return { runtime, state };
}
function preparedImages(): NativeContextImagesResult {
  return {
    messages: [image("first"), image("second")],
    sentImages: ["first", "second"].map((ref) => ({
      ref,
      responseMessageId: "response",
      logicalRequestId: "pending",
      modelKey: "fixture/vision",
      policyHash: "2".repeat(64),
      representationHash: "3".repeat(64),
      generation: 0,
    })),
    imageChanges: {
      omittedRefs: [],
      foldedRefs: [],
      resizedRefs: ["first", "second"],
      restoredRefs: [],
    },
  };
}
test("final media gate keeps the staging array identity and counts only the sent resized images", () => {
  const { state } = fixture(),
    prepared = preparedImages(),
    originalArray = prepared.sentImages;
  retainNativeSentImages(state, prepared, [image("second")]);
  assert.equal(prepared.sentImages, originalArray);
  assert.deepEqual(
    prepared.sentImages.map((receipt) => receipt.ref),
    ["second"],
  );
  assert.deepEqual(prepared.imageChanges.resizedRefs, ["second"]);
  assert.deepEqual(prepared.imageChanges.omittedRefs, ["first"]);
});
test("a restored original removed by the final gate fails instead of reporting a successful restore", () => {
  const { state } = fixture(),
    prepared = preparedImages();
  const restored = prepared.messages[0]!.content;
  assert.ok(Array.isArray(restored) && restored[0]?.type === "image");
  restored[0].source!.id = "context-original-original-ref";
  prepared.imageChanges.restoredRefs.push("original-ref");
  assert.throws(
    () => retainNativeSentImages(state, prepared, [image("second")]),
    /original-image-capacity/u,
  );
});
test("an original baseline over the current media budget remains unknown while its text estimate is available", () => {
  const huge: ModelInputMessage[] = [
    {
      role: "user",
      content: [
        {
          type: "image",
          mediaType: "image/png",
          dataUrl: "data:image/png;base64," + "A".repeat(40 * 1024 * 1024),
        },
        { type: "text", text: "合成上传" },
      ],
    },
  ];
  const baseline = nativeModelBaseline(huge, model, 0);
  assert.equal(baseline.baselineMeasurable, false);
  assert.equal(baseline.messages, huge);
  assert.equal(baseline.messages[0]!.content, huge[0]!.content);
});
test("baseline and actual request use the same capability gate without creating a fake image receipt", async () => {
  const { runtime, state } = fixture();
  const textModel = {
    ...model,
    properties: {
      ...model.properties,
      inputFormat: { ...model.properties.inputFormat, supportsImage: false },
    },
  } as Model;
  const options = {
    assistantMessageId: createMessageId("response"),
    events: [],
    tools: [],
    model: textModel,
    messages: [image("unbound")],
    maxOutputTokens: 1000,
    latestRealUserMessageIndex: 0,
    traceContext: runtime.rootTraceContext,
    nativeContextComparison: {
      baselineMessages: [image("unbound")],
      baselineEntries: [],
      historyVersion: state.historyVersion,
      generation: 0,
      policyVersion: state.policy.policyVersion,
      policy: state.policy,
      segmentId: state.compactBoundaryId,
      operationIds: [],
    },
  } as RunModelTextRequestOptions;
  const prepared = await prepareNativeModelRequest(runtime, options);
  assert.ok(
    prepared.options.messages.every(
      (message) =>
        !Array.isArray(message.content) || message.content.every((block) => block.type !== "image"),
    ),
  );
  assert.equal(prepared.sentImages.length, 0);
  assert.ok(prepared.tracker);
});
