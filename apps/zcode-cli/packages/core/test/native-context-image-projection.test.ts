import assert from "node:assert/strict";
import { test } from "node:test";
import { imageFixture, imageModel, pngHeaderBytes } from "./native-context-image-fixture.js";
import {
  prepareNativeContextImages,
  commitNativeImageReceipts,
} from "../src/runtime/native-context-compression/images.js";
import { kernelOf } from "../src/runtime/native-context-compression/state.js";
import { nativeHash } from "../src/runtime/native-context-compression/identity.js";

async function deliver(f: ReturnType<typeof imageFixture>) {
  const input = f.request(),
    result = await prepareNativeContextImages(f.runtime, input);
  for (const receipt of result.sentImages)
    receipt.logicalRequestId = "completed-" + input.assistantMessageId;
  f.complete(input);
  await commitNativeImageReceipts(f.runtime, result.sentImages, input.comparison);
  return result;
}
function imageBlocks(result: Awaited<ReturnType<typeof prepareNativeContextImages>>) {
  return result.messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((block) => block.type === "image");
}
test("omitSeen needs a matching complete receipt; equal bytes at a new FilePart are sent separately", async () => {
  const f = imageFixture();
  f.state.policy.parameters.images.omitSeen = true;
  f.addImage("old");
  f.addText("latest");
  const first = await deliver(f);
  const oldRef = first.sentImages[0]!.ref;
  f.addImage("new-equal");
  f.addText("new-latest");
  const input = f.request(),
    result = await prepareNativeContextImages(f.runtime, input);
  assert.deepEqual(result.imageChanges.omittedRefs, [oldRef]);
  assert.equal(imageBlocks(result).length, 1);
  assert.equal(result.sentImages.length, 1);
  assert.notEqual(result.sentImages[0]!.ref, oldRef);
  assert.equal(imageBlocks(result)[0]!.source!.canonicalPartId, "new-equal-image");
});
test("the latest actual user turn remains visible when more tool/assistant entries follow it", async () => {
  const f = imageFixture();
  f.state.policy.parameters.images.omitSeen = true;
  f.addImage("latest-image");
  await deliver(f);
  f.addText("tool-output", "tool");
  const result = await prepareNativeContextImages(f.runtime, f.request());
  assert.equal(imageBlocks(result).length, 1);
  assert.deepEqual(result.imageChanges.omittedRefs, []);
});
test("image retention counts distinct actual user messages and does not count assistant or tool carriers", async () => {
  const f = imageFixture();
  f.state.policy.parameters.images.omitSeen = true;
  f.state.policy.parameters.images.keepRecentUserTurns = 2;
  f.addImage("old");
  f.addText("latest");
  await deliver(f);
  f.addText("synthetic", "user").metadata = { source: "legacy_synthetic" };
  f.addText("tool-after", "tool");
  const result = await prepareNativeContextImages(f.runtime, f.request());
  assert.equal(imageBlocks(result).length, 1);
  assert.deepEqual(result.imageChanges.omittedRefs, []);
});
for (const change of ["model", "jpeg-policy", "detail", "hard-budget"] as const) {
  test(change + " invalidates old receipt before any new omission", async () => {
    const f = imageFixture();
    f.state.policy.parameters.images.omitSeen = true;
    const block = f.addImage("old");
    f.addText("latest");
    const first = await deliver(f);
    if (change === "jpeg-policy") {
      f.state.policy.parameters.images.jpegQuality = 81;
      f.state.policy.policyVersion++;
    }
    if (change === "detail") block.detail = "high";
    const input = f.request(
      change === "model"
        ? { model: imageModel("other-model") }
        : change === "hard-budget"
          ? { maxRawBytes: 3072 }
          : {},
    );
    const result = await prepareNativeContextImages(f.runtime, input);
    assert.equal(imageBlocks(result).length, 1);
    assert.deepEqual(result.imageChanges.omittedRefs, []);
    assert.notEqual(result.sentImages[0]!.policyHash, first.sentImages[0]!.policyHash);
  });
}
test("manual reuses the committed sending view and omission after parameter changes", async () => {
  const f = imageFixture();
  f.state.policy.parameters.images.omitSeen = true;
  f.addImage("old");
  f.addText("latest");
  const first = await deliver(f);
  const encoded = imageBlocks(first)[0]!.dataUrl;
  f.state.policy.mode = "manual";
  f.state.policy.policyVersion++;
  f.state.policy.parameters.images.jpegQuality = 90;
  let result = await prepareNativeContextImages(f.runtime, f.request());
  assert.equal(imageBlocks(result)[0]!.dataUrl, encoded);
  assert.equal(f.calls.length, 1);
  assert.equal(result.sentImages[0]!.policyHash, first.sentImages[0]!.policyHash);
  kernelOf(f.state).omittedImageRefs = [first.sentImages[0]!.ref];
  result = await prepareNativeContextImages(f.runtime, f.request());
  assert.equal(imageBlocks(result).length, 0);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(result.imageChanges.omittedRefs, [first.sentImages[0]!.ref]);
});
test("manual leaves a new image at its original encoding", async () => {
  const f = imageFixture("manual"),
    original = f.addImage("old");
  f.addText("latest");
  const result = await prepareNativeContextImages(f.runtime, f.request());
  assert.equal(imageBlocks(result)[0]!.dataUrl, original.dataUrl);
  assert.equal(f.calls.length, 0);
  assert.equal(f.writes.length, 0);
});
test("a covered summary keeps image carrier until final receipt-aware fold; fold switch preserves image", async () => {
  const f = imageFixture();
  f.addImage("old");
  f.addText("latest");
  const first = await deliver(f);
  kernelOf(f.state).compression.blocks.push({
    blockId: "b1",
    runId: "r1",
    tier: 1,
    summary: "short",
    directMessageIds: ["old#e0"],
    effectiveMessageIds: ["old#e0"],
    directBlockIds: [],
    compressedTokens: 1,
    createdAt: 10,
    survivedCount: 0,
    generation: "young",
    active: true,
  });
  let result = await prepareNativeContextImages(f.runtime, f.request());
  assert.equal(imageBlocks(result).length, 0);
  assert.deepEqual(result.imageChanges.foldedRefs, [first.sentImages[0]!.ref]);
  f.state.policy.parameters.images.foldWithHistory = false;
  f.state.policy.policyVersion++;
  result = await prepareNativeContextImages(f.runtime, f.request());
  assert.equal(imageBlocks(result).length, 1);
  assert.deepEqual(result.imageChanges.foldedRefs, []);
});
test("metadata-preserved exact raster bypasses the image encoder and checks real header dimensions", async () => {
  const f = imageFixture(),
    block = f.addImage("old", pngHeaderBytes(), "raster", true);
  f.addText("latest");
  const result = await prepareNativeContextImages(f.runtime, f.request());
  assert.equal(imageBlocks(result)[0]!.dataUrl, block.dataUrl);
  assert.equal(f.calls.length, 0);
  const tooLarge = imageFixture();
  tooLarge.addImage("wide", pngHeaderBytes(4096, 2500, 800), "wide-raster", true);
  tooLarge.addText("latest");
  await assert.rejects(
    prepareNativeContextImages(tooLarge.runtime, tooLarge.request()),
    (error: unknown) =>
      typeof error === "object" && error !== null && "code" in error && error.code === "too_large",
  );
  assert.equal(tooLarge.calls.length, 0);
  assert.equal(tooLarge.commits.length, 0);
});
test("copy benefit includes the reference note and zero percent still needs fewer bytes", async () => {
  const f = imageFixture(),
    original = f.addImage("old");
  f.addText("latest");
  f.state.policy.parameters.images.minReductionPercent = 0;
  f.setEncoder((request) => ({
    data: pngHeaderBytes(4080, 512, 256),
    mediaType: "image/png",
    resized: true,
    compressed: true,
    strategy: "resized",
    originalSizeBytes: request.data.byteLength,
    transformedSizeBytes: 4080,
    width: 512,
    height: 256,
  }));
  const result = await prepareNativeContextImages(f.runtime, f.request());
  assert.equal(imageBlocks(result)[0]!.dataUrl, original.dataUrl);
  assert.equal(f.writes.length, 0);
  assert.equal(result.sentImages[0]!.representationHash, nativeHash(pngHeaderBytes()));
});
test("untracked or duplicate part identity does not manufacture shared received state", async () => {
  const f = imageFixture();
  f.addImage("same-a", pngHeaderBytes(), "ambiguous");
  f.addImage("same-b", pngHeaderBytes(), "ambiguous");
  f.addText("latest");
  const result = await prepareNativeContextImages(f.runtime, f.request());
  assert.equal(imageBlocks(result).length, 2);
  assert.equal(result.sentImages.length, 0);
  assert.equal(f.calls.length, 0);
});
test("frozen policy reaches the encoder even if the owner changes while processing; candidate does not commit", async () => {
  const f = imageFixture();
  f.addImage("old");
  f.addText("latest");
  const input = f.request();
  f.setEncoder((request) => {
    assert.equal(request.nativeContextPolicy!.jpegQuality, 80);
    f.state.policy.parameters.images.jpegQuality = 81;
    f.state.policy.policyVersion++;
    return {
      data: pngHeaderBytes(1024, 512, 256),
      mediaType: "image/png",
      resized: true,
      compressed: true,
      strategy: "resized",
      originalSizeBytes: request.data.byteLength,
      transformedSizeBytes: 1024,
    };
  });
  await assert.rejects(prepareNativeContextImages(f.runtime, input), /image-boundary/u);
  assert.equal(f.state.imageReceipts.length, 0);
  assert.equal(f.commits.length, 0);
});
test("another block cannot impersonate a canonical FilePart by copying only its identity", async () => {
  const f = imageFixture();
  f.addImage("old");
  f.addText("latest");
  const input = f.request(),
    content = input.messages[0]!.content;
  assert.ok(Array.isArray(content));
  const image = content.find((block) => block.type === "image")!;
  image.dataUrl = "data:image/png;base64," + pngHeaderBytes(4096, 512, 100).toString("base64");
  await assert.rejects(prepareNativeContextImages(f.runtime, input), /image-identity/u);
  assert.equal(f.calls.length, 0);
  assert.equal(f.commits.length, 0);
});
