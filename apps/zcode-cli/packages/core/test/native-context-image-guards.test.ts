import assert from "node:assert/strict";
import { test } from "node:test";
import type { RuntimeMessageEntry } from "../src/agent/message-history.js";
import { imageFixture, textEntry, countTokens } from "./native-context-image-fixture.js";
import {
  protectedNativeIds,
  nativeSummaryRanges,
} from "../src/runtime/native-context-compression/guards.js";
import { syncNativeSources } from "../src/runtime/native-context-compression/sources.js";
import {
  nativeEntriesWithImageIdentity,
  projectNativeEntries,
} from "../src/runtime/native-context-compression/projection.js";
import {
  prepareNativeContextImages,
  commitNativeImageReceipts,
} from "../src/runtime/native-context-compression/images.js";
import { kernelOf } from "../src/runtime/native-context-compression/state.js";

function completedToolEntries(name = "Read"): RuntimeMessageEntry[] {
  const call = textEntry("tools", "assistant", "call", 0);
  call.message.toolCalls = [{ id: "read-call", name, input: { file: "fixture-file" } }];
  const result = textEntry("tools", "tool", "completed output", 1);
  result.message.toolCallId = "read-call";
  result.message.toolName = name;
  return [call, result];
}
test("summary ranges include every sidecar call ID and all fragments of a completed message", () => {
  const f = imageFixture();
  f.state.policy.parameters.summary.minRangeChars = 1;
  f.state.policy.parameters.history.protectedTools = [];
  f.state.policy.parameters.history.protectedLatestTools = [];
  const call = textEntry("tools", "assistant", "call", 0);
  call.message.toolCalls = [
    { id: "a", name: "FixtureRead", input: { file: "a" } },
    { id: "b", name: "FixtureRead", input: { file: "b" } },
  ];
  const a = textEntry("tools", "tool", "output a", 1),
    b = textEntry("tools", "tool", "output b", 2);
  a.message.toolCallId = "a";
  b.message.toolCallId = "b";
  const entries = [textEntry("old", "user", "history"), call, a, b, textEntry("latest", "user")];
  syncNativeSources(f.state, entries, countTokens);
  const range = nativeSummaryRanges(entries, f.state, countTokens)[0]!;
  assert.deepEqual(range.rawIds, [
    "old#e0",
    "tools#e0",
    "tools#e0:c0",
    "tools#e0:c1",
    "tools#e1",
    "tools#e2",
  ]);
  assert.equal(range.endRef, kernelOf(f.state).compression.messageRefs.byRaw["tools#e2"]);
  assert.equal(range.entries.length, 4);
});
test("multiple fragments of one real user are one preserved turn", () => {
  const f = imageFixture();
  f.state.policy.parameters.history.preserveTurns = 2;
  const entries = [
    textEntry("prior", "user"),
    textEntry("latest", "user", "text", 0),
    textEntry("latest", "user", "image fragment", 1),
  ];
  syncNativeSources(f.state, entries, countTokens);
  assert.equal(protectedNativeIds(entries, f.state, countTokens).has("prior#e0"), true);
});
test("early completed tool folding bypasses only recent protection; pending and signed groups remain protected", () => {
  const f = imageFixture(),
    policy = f.state.policy.parameters.history;
  policy.preserveTokens = 10000;
  policy.earlyFoldTools = ["Read"];
  policy.preserveRecentTools = [];
  policy.protectedTools = [];
  policy.protectedLatestTools = [];
  const completed = completedToolEntries();
  const pending = textEntry("pending", "assistant");
  pending.message.toolCalls = [{ id: "pending", name: "Read", input: {} }];
  const signed = completedToolEntries();
  signed.forEach((entry) => {
    entry.canonical!.messageId = "signed";
  });
  if (signed[0]!.kind !== "attachment")
    signed[0]!.message.toolCalls![0]!.providerOptions = { thoughtSignature: "fixture-signature" };
  const entries = [
    textEntry("old", "user"),
    ...completed,
    pending,
    ...signed,
    textEntry("latest", "user"),
  ];
  syncNativeSources(f.state, entries, countTokens);
  const protectedIds = protectedNativeIds(entries, f.state, countTokens);
  assert.equal(protectedIds.has("tools#e0"), false);
  assert.equal(protectedIds.has("tools#e1"), false);
  assert.equal(protectedIds.has("pending#e0"), true);
  assert.equal(protectedIds.has("pending#e0:c0"), true);
  assert.equal(protectedIds.has("signed#e0"), true);
  assert.equal(protectedIds.has("signed#e1"), true);
  policy.preserveRecentTools = ["Read"];
  assert.equal(protectedNativeIds(entries, f.state, countTokens).has("tools#e1"), true);
});
test("attachment or signed fragment protects the whole persisted message and cannot create a half range", () => {
  const f = imageFixture();
  f.state.policy.parameters.summary.minRangeChars = 1;
  const entries: RuntimeMessageEntry[] = [
    textEntry("whole", "assistant", "candidate text", 0),
    {
      kind: "attachment",
      content: "protected attachment",
      metadata: { source: "legacy_synthetic" },
      canonical: { messageId: "whole", createdAt: 10, entryIndex: 1 },
    },
    textEntry("latest", "user"),
  ];
  syncNativeSources(f.state, entries, countTokens);
  assert.equal(protectedNativeIds(entries, f.state, countTokens).has("whole#e0"), true);
  assert.equal(nativeSummaryRanges(entries, f.state, countTokens).length, 0);
});
test("noncontiguous fragments are excluded as a whole instead of becoming independent summary ranges", () => {
  const f = imageFixture();
  f.state.policy.parameters.summary.minRangeChars = 1;
  const entries = [
    textEntry("whole", "assistant", "first", 0),
    textEntry("other", "assistant", "other"),
    textEntry("whole", "assistant", "last", 1),
    textEntry("latest", "user"),
  ];
  syncNativeSources(f.state, entries, countTokens);
  const ranges = nativeSummaryRanges(entries, f.state, countTokens);
  assert.equal(
    ranges.flatMap((range) => range.rawIds).some((raw) => raw.startsWith("whole#")),
    false,
  );
});
test("unreceived or unavailable original image protects every fragment of its persisted message", async () => {
  const f = imageFixture();
  f.addImage("whole");
  f.entries.push(textEntry("whole", "user", "sibling", 1));
  f.addText("latest");
  let input = f.request();
  assert.equal(protectedNativeIds(f.entries, f.state, countTokens).has("whole#e1"), true);
  const result = await prepareNativeContextImages(f.runtime, input);
  for (const receipt of result.sentImages) receipt.logicalRequestId = "complete";
  f.complete(input);
  await commitNativeImageReceipts(f.runtime, result.sentImages, input.comparison);
  input = f.request();
  assert.equal(
    protectedNativeIds(input.comparison!.baselineEntries, f.state, countTokens).has("whole#e1"),
    false,
  );
  f.state.sources.find((source) => source.kind === "image")!.originalAvailable = false;
  assert.equal(protectedNativeIds(f.entries, f.state, countTokens).has("whole#e1"), true);
});
test("covered tool images have synthetic carriers with exact identity and no dangling tool protocol", () => {
  const f = imageFixture();
  f.addImage("old");
  f.sync();
  const original = f.state.sources.find((source) => source.kind === "image")!;
  const block = f.addRestore(original.ref);
  const toolEntries = f.entries.filter((entry) =>
    entry.canonical?.messageId.startsWith("restore-"),
  );
  const messageId = toolEntries[0]!.canonical!.messageId;
  f.addText("latest");
  f.sync();
  kernelOf(f.state).compression.blocks.push({
    blockId: "b1",
    runId: "r1",
    tier: 1,
    summary: "summary",
    directMessageIds: [messageId + "#e0", messageId + "#e0:c0", messageId + "#e1"],
    effectiveMessageIds: [messageId + "#e0", messageId + "#e0:c0", messageId + "#e1"],
    directBlockIds: [],
    compressedTokens: 1,
    createdAt: 10,
    survivedCount: 0,
    generation: "young",
    active: true,
  });
  f.state.policy.parameters.prompts.visibilityMarkers = false;
  const projected = projectNativeEntries(f.entries, f.state),
    carrier = projected.find((entry) => entry.canonical?.messageId === messageId)!;
  assert.ok(
    projected.some((entry) => entry.kind !== "attachment" && entry.message.content === "summary"),
  );
  assert.equal(carrier.kind !== "attachment" ? carrier.message.role : null, "user");
  assert.equal(carrier.metadata?.source, "legacy_synthetic");
  if (carrier.kind !== "attachment") {
    assert.equal(carrier.message.toolCallId, undefined);
    assert.equal(carrier.message.toolCalls, undefined);
    assert.ok(Array.isArray(carrier.message.content));
    assert.equal(
      carrier.message.content[0]?.type === "image"
        ? carrier.message.content[0].source?.canonicalPartId
        : null,
      block.source?.canonicalPartId,
    );
  }
});
test("committed reasoning omission does not depend on later mode or threshold, while signed reasoning remains", () => {
  const f = imageFixture("manual");
  const old = f.addText("old", "assistant");
  old.message.content = [
    { type: "text", text: "kept" },
    { type: "reasoning", text: "short" },
    { type: "reasoning", text: "signed", providerOptions: { signature: "fixture-signature" } },
  ];
  f.state.policy.parameters.reasoning.thresholdChars = 100000;
  kernelOf(f.state).omittedReasoningIds = ["old#e0"];
  const before = structuredClone(old),
    projected = projectNativeEntries(f.entries, f.state);
  assert.deepEqual(old, before);
  const content = projected[0]!.kind !== "attachment" ? projected[0]!.message.content : null;
  assert.ok(Array.isArray(content));
  assert.deepEqual(
    content.map((block) => (block.type === "reasoning" ? block.text : "")),
    ["", "signed"],
  );
});
test("baseline identity derives from real imagePartIds and conflicting source identity fails closed", () => {
  const f = imageFixture(),
    block = f.addImage("old");
  delete block.source!.canonicalPartId;
  const entries = nativeEntriesWithImageIdentity(f.entries);
  assert.equal(block.source!.canonicalPartId, undefined);
  const content = entries[0]!.kind !== "attachment" ? entries[0]!.message.content : null;
  assert.ok(Array.isArray(content));
  assert.equal(
    content[1]?.type === "image" ? content[1].source?.canonicalPartId : null,
    "old-image",
  );
  block.source!.canonicalPartId = "another-part";
  assert.throws(() => nativeEntriesWithImageIdentity(f.entries), /image-identity/u);
});
