import assert from "node:assert/strict";
import test from "node:test";
import type { Model, ModelInputMessage } from "@zcode/contracts";
import type { NativeContextObservation } from "@zcode/shared/native-context-compression";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import {
  initialNativeState,
  nativeOwner,
} from "../src/runtime/native-context-compression/state.js";
import { nativeTextEstimate } from "../src/runtime/native-context-compression/measurements.js";
import {
  nativeContextTokenEstimate,
  nativeContextUsageTokenOverride,
} from "../src/runtime/native-context-compression/safe-point.js";

const model = { providerId: "fixture", modelId: "fixture-model" } as Model;
const messages: ModelInputMessage[] = [
  { role: "user", content: "Synthetic current request text." },
];
function fixture() {
  const runtime = {
    config: {},
    branchGeneration: 0,
    sessionStore: { commitNativeContext: async () => {} },
    messageHistory: { borrowReadOnlyRuntimeEntries: () => [] },
  } as unknown as AgentRuntimeInternal;
  const owner = nativeOwner(runtime);
  owner.state = initialNativeState(runtime);
  return { runtime, owner };
}
function observation(overrides: Partial<NativeContextObservation> = {}): NativeContextObservation {
  return {
    id: "physical-attempt",
    logicalRequestId: "physical",
    usageRecordRef: "usage",
    attemptIndex: 0,
    requestSeq: 1,
    purpose: "main",
    status: "completed",
    generation: 0,
    historyVersion: "history",
    policyVersion: 0,
    segmentId: "initial",
    estimatorVersion: "native-context-v1",
    measurementScope: "complete",
    model: { providerId: "fixture", modelId: "fixture-model" },
    inputBudget: 10000,
    contextWindow: 11000,
    startTokens: 9000,
    targetTokens: 7000,
    beforeEstimate: 1000,
    afterEstimate: 800,
    textBeforeEstimate: 1000,
    textAfterEstimate: 800,
    actualInputTokens: 2000,
    outputTokens: 32,
    cacheReadTokens: 0,
    cacheCreateTokens: null,
    visionTokens: null,
    images: {
      sourceCount: 0,
      sourceCoverage: 0,
      sentCount: 0,
      omittedCount: 0,
      foldedCount: 0,
      resizedCount: 0,
      restoredCount: 0,
      beforeBytes: 0,
      afterBytes: 0,
    },
    operationIds: [],
    origin: "own",
    createdAt: 1,
    completedAt: 2,
    ...overrides,
  };
}
test("a native request without a real sample retains its local estimate source", () => {
  const { runtime } = fixture();
  assert.equal(nativeContextUsageTokenOverride(runtime, messages, [], model), undefined);
  assert.equal(
    nativeContextTokenEstimate(runtime, messages, [], model),
    nativeTextEstimate(messages, []),
  );
});
test("the completed same-model sample anchors actual input and the projected text delta", () => {
  const { runtime, owner } = fixture();
  owner.lastObservation = observation();
  const delta = nativeTextEstimate(messages, []) - owner.lastObservation.textAfterEstimate!;
  const override = nativeContextUsageTokenOverride(runtime, messages, [], model)!;
  assert.equal(override.source, "provider_usage");
  assert.equal(override.baseTokenCount, 2000);
  assert.equal(override.incrementalTokenCount, delta);
  assert.equal(override.tokenCount, 2000 + delta);
  assert.equal(override.cacheReadTokens, 0);
  assert.equal(override.cacheWriteTokens, undefined);
});
test("foreign, incomplete, maintenance and unknown-input samples never authorize a provider baseline", () => {
  for (const overrides of [
    { model: { providerId: "other", modelId: "fixture-model" } },
    { model: { providerId: "fixture", modelId: "other" } },
    { generation: 1 },
    { segmentId: "different-compact" },
    { purpose: "maintenance" },
    { status: "prepared" },
    { status: "cancelled" },
    { status: "error" },
    { actualInputTokens: null },
    { textAfterEstimate: null },
  ] satisfies Partial<NativeContextObservation>[]) {
    const { runtime, owner } = fixture();
    owner.lastObservation = observation(overrides);
    assert.equal(nativeContextUsageTokenOverride(runtime, messages, [], model), undefined);
    assert.equal(
      nativeContextTokenEstimate(runtime, messages, [], model),
      nativeTextEstimate(messages, []),
    );
  }
});
test("true zero usage remains measurable and a branch transition rejects the previous sample", () => {
  const { runtime, owner } = fixture();
  owner.lastObservation = observation({
    actualInputTokens: 0,
    textAfterEstimate: nativeTextEstimate(messages, []),
    outputTokens: 0,
  });
  assert.equal(nativeContextUsageTokenOverride(runtime, messages, [], model)!.tokenCount, 0);
  runtime.branchGeneration = 1;
  assert.equal(nativeContextUsageTokenOverride(runtime, messages, [], model), undefined);
});
