import assert from "node:assert/strict";
import { test } from "node:test";
import { createRecommendedNativeContextConfiguration } from "@zcode/shared/native-context-compression";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import type { RuntimeMessageEntry } from "../src/agent/message-history.js";
import { initialNativeState, kernelOf, nativeOwner, writeNativeState } from "../src/runtime/native-context-compression/state.js";
import { syncNativeSources } from "../src/runtime/native-context-compression/sources.js";
import { protectedNativeIds, nativeSummaryRanges } from "../src/runtime/native-context-compression/guards.js";
import { projectNativeEntries } from "../src/runtime/native-context-compression/projection.js";

const countTokens = (text: string) => Math.ceil(text.length / 4);
function entry(id: string, role: "user" | "assistant" | "tool", text: string, index = 0): RuntimeMessageEntry {
  return { message: { role, content: text }, canonical: { messageId: id, createdAt: 10, entryIndex: index } };
}
function runtime(): AgentRuntimeInternal {
  return { branchGeneration: 0, sessionId: "native_test", config: {}, messageHistory: { borrowReadOnlyRuntimeEntries: () => [] }, sessionPersisted: false } as unknown as AgentRuntimeInternal;
}
test("canonical IDs keep equal text distinct; refs and token stamps are frozen", () => {
  const state = initialNativeState(runtime());
  const entries = [entry("user_a", "user", "same"), entry("user_b", "user", "same")];
  syncNativeSources(state, entries, countTokens);
  const saved = structuredClone(state.sources);
  syncNativeSources(state, entries, () => 100);
  assert.deepEqual(state.sources, saved);
  assert.notEqual(saved[0]!.ref, saved[1]!.ref);
  assert.equal(kernelOf(state).compression.tokenSnapshot[saved[0]!.ref], 1);
});
test("latest real user and its whole turn stay outside summary ranges", () => {
  const parameters = createRecommendedNativeContextConfiguration().parameters;
  parameters.history.preserveMessages = 0; parameters.history.preserveTokens = 0; parameters.history.preserveTurns = 0;
  parameters.summary.minRangeChars = 1;
  const entries = [entry("old_u", "user", "old user"), entry("old_a", "assistant", "old answer"), entry("new_u", "user", "new user"), entry("new_a", "assistant", "new answer")];
  const state = initialNativeState(runtime(), { ...createRecommendedNativeContextConfiguration(), parameters });
  syncNativeSources(state, entries, countTokens);
  const protectedIds = protectedNativeIds(entries, state, countTokens);
  assert.equal(protectedIds.has("new_u#e0"), true);
  assert.equal(protectedIds.has("new_a#e0"), true);
  assert.equal(nativeSummaryRanges(entries, state, countTokens).flatMap((range) => range.rawIds).some((id) => id.startsWith("new_")), false);
});
test("an unfinished call protects every entry of its persisted message", () => {
  const state = initialNativeState(runtime());
  const assistant = entry("assistant_group", "assistant", "call", 0);
  if (assistant.kind !== "attachment") assistant.message.toolCalls = [{ id: "pending", name: "Read", input: { file: "synthetic.txt" } }];
  const entries = [assistant, entry("assistant_group", "assistant", "other round", 1), entry("new", "user", "latest")];
  syncNativeSources(state, entries, countTokens);
  assert.equal(protectedNativeIds(entries, state, countTokens).has("assistant_group#e1"), true);
});
test("persistence rejection leaves the committed policy and revision intact", async () => {
  const host = runtime();
  host.sessionStore = { commitNativeContext: async () => { throw new Error("synthetic storage failure"); } } as unknown as AgentRuntimeInternal["sessionStore"];
  const owner = nativeOwner(host); owner.state = initialNativeState(host);
  const before = structuredClone(owner.state);
  await assert.rejects(writeNativeState(owner, (candidate) => { candidate.policy.mode = "auto"; }));
  assert.deepEqual(owner.state, before);
});
test("missing storage cannot manufacture a successful compression commit", async () => {
  const owner = nativeOwner(runtime()); owner.state = initialNativeState(owner.runtime);
  await assert.rejects(writeNativeState(owner, () => undefined), /unsupported-store/u);
});
test("summary projection preserves canonical text and leaves the latest turn visible", () => {
  const state = initialNativeState(runtime());
  const entries = [entry("old", "user", "large original"), entry("new", "user", "latest")];
  syncNativeSources(state, entries, countTokens);
  kernelOf(state).compression.blocks.push({ blockId: "b1", runId: "r1", tier: 1, summary: "short summary", directMessageIds: ["old#e0"], effectiveMessageIds: ["old#e0"], directBlockIds: [], compressedTokens: 10, createdAt: 10, survivedCount: 0, generation: "young", active: true });
  const before = structuredClone(entries);
  const projected = projectNativeEntries(entries, state);
  assert.deepEqual(entries, before);
  assert.equal(projected.some((item) => item.kind !== "attachment" && item.message.content === "latest"), true);
  assert.equal(projected.some((item) => item.kind !== "attachment" && item.message.content === "large original"), false);
});
