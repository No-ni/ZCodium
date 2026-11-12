import assert from "node:assert/strict";
import test from "node:test";
import { createRecommendedNativeContextConfiguration } from "@zcode/shared/native-context-compression";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import type { RuntimeMessageEntry } from "../src/agent/message-history.js";
import { initialNativeState, kernelOf } from "../src/runtime/native-context-compression/state.js";
import { syncNativeSources } from "../src/runtime/native-context-compression/sources.js";
import { nativeCountTokens } from "../src/runtime/native-context-compression/measurements.js";
import {
  applyNativeToolViews,
  nativeOutputCandidates,
} from "../src/runtime/native-context-compression/tool-views.js";

function fixture() {
  const config = createRecommendedNativeContextConfiguration();
  config.parameters.history.protectedLatestTools = [];
  config.parameters.tools.simplify.enabled = false;
  config.parameters.tools.reference.excludeTools = [];
  config.parameters.tools.reference.minTokens = 10;
  config.parameters.tools.reference.headChars = 10;
  config.parameters.tools.distill.enabled = true;
  config.parameters.tools.distill.excludeTools = [];
  config.parameters.tools.distill.minContextPercent = 50;
  config.parameters.tools.distill.minTokens = 10;
  config.parameters.tools.distill.mediaOnly = false;
  const entries: RuntimeMessageEntry[] = [
    {
      message: {
        role: "tool",
        toolCallId: "call",
        toolName: "Read",
        content: "可回取完整原始结果 ".repeat(1000),
      },
      canonical: { messageId: "result", createdAt: 1, entryIndex: 0, partId: "result-part" },
    },
  ];
  const runtime = {
    config: {},
    branchGeneration: 0,
    messageHistory: { borrowReadOnlyRuntimeEntries: () => entries },
  } as unknown as AgentRuntimeInternal;
  const state = initialNativeState(runtime, config);
  syncNativeSources(state, entries, nativeCountTokens);
  return { entries, state };
}
test("eligible model distillation is not silently disabled by an earlier reference conversion", () => {
  const { entries, state } = fixture();
  applyNativeToolViews(state, entries, { currentTokens: 6000, inputBudget: 10_000 });
  assert.equal(kernelOf(state).views["result#e0"], undefined);
  assert.equal(nativeOutputCandidates(entries, state, 6000, 10_000).length, 1);
});
test("below distillation pressure the result is referenced once and is not paid for again", () => {
  const { entries, state } = fixture();
  applyNativeToolViews(state, entries, { currentTokens: 1000, inputBudget: 10_000 });
  assert.equal(kernelOf(state).views["result#e0"]?.kind, "reference");
  assert.equal(nativeOutputCandidates(entries, state, 9000, 10_000).length, 0);
});
