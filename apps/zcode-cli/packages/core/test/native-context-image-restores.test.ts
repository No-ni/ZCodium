import assert from "node:assert/strict";
import { test } from "node:test";
import { imageFixture, imageModel, pngHeaderBytes } from "./native-context-image-fixture.js";
import {
  prepareNativeContextImages,
  commitNativeImageReceipts,
} from "../src/runtime/native-context-compression/images.js";
import { readNativeContextImage } from "../src/runtime/native-context-compression/read.js";
import { kernelOf } from "../src/runtime/native-context-compression/state.js";

async function completed(f: ReturnType<typeof imageFixture>) {
  const input = f.request(),
    result = await prepareNativeContextImages(f.runtime, input);
  for (const receipt of result.sentImages)
    receipt.logicalRequestId = "completed-" + input.assistantMessageId;
  f.complete(input);
  await commitNativeImageReceipts(f.runtime, result.sentImages, input.comparison);
  return result;
}
async function restoredFixture() {
  const f = imageFixture();
  f.state.policy.parameters.images.omitSeen = true;
  f.addImage("old");
  f.addText("latest");
  const first = await completed(f),
    ref = first.sentImages[0]!.ref;
  await completed(f);
  assert.ok(kernelOf(f.state).omittedImageRefs?.includes(ref));
  const block = f.addRestore(ref);
  return { f, ref, block };
}
function images(result: Awaited<ReturnType<typeof prepareNativeContextImages>>) {
  return result.messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((block) => block.type === "image");
}
test("UI original preview returns immutable bytes but creates no model-sending exemption", async () => {
  const f = imageFixture();
  f.addImage("old");
  f.request();
  const source = f.state.sources.find((item) => item.kind === "image")!;
  const page = await readNativeContextImage.call(f.runtime, {
    ref: source.ref,
    expectedRevision: f.state.revision,
  });
  assert.equal(page.originalAvailable, true);
  assert.deepEqual(Buffer.from(page.dataBase64!, "base64"), pngHeaderBytes());
  assert.equal(f.owner.restoreImageRefs, undefined);
  assert.equal(f.calls.length, 0);
  assert.equal(f.commits.length, 0);
});
test("a completed context_read_image attachment sends the exact original once and avoids old/new duplication", async () => {
  const { f, ref, block } = await restoredFixture();
  const input = f.request(),
    result = await prepareNativeContextImages(f.runtime, input);
  assert.equal(images(result).length, 1);
  assert.equal(images(result)[0]!.dataUrl, block.dataUrl);
  assert.deepEqual(result.imageChanges.restoredRefs, [ref]);
  assert.equal(result.sentImages.length, 1);
  assert.notEqual(result.sentImages[0]!.ref, ref);
  assert.equal(f.owner.restoreImageRefs?.has(ref), true);
  assert.equal(f.calls.length, 1);
  for (const receipt of result.sentImages) receipt.logicalRequestId = "restored-request";
  f.complete(input);
  await commitNativeImageReceipts(f.runtime, result.sentImages, input.comparison);
  assert.equal(f.owner.restoreImageRefs?.has(ref), false);
  const following = await prepareNativeContextImages(f.runtime, f.request());
  assert.deepEqual(following.imageChanges.restoredRefs, []);
  assert.equal(f.calls.length, 2);
  assert.notEqual(images(following)[0]!.dataUrl, block.dataUrl);
});
test("the exact restored original cannot be downsampled to pass a smaller hard budget", async () => {
  const { f, ref } = await restoredFixture(),
    before = structuredClone(f.state);
  const input = f.request({ maxRawBytes: 3072 });
  const synced = structuredClone(f.state);
  await assert.rejects(
    prepareNativeContextImages(f.runtime, input),
    (error: unknown) =>
      typeof error === "object" && error !== null && "code" in error && error.code === "too_large",
  );
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.state, synced);
  assert.equal(f.state.imageReceipts.length, before.imageReceipts.length);
  assert.equal(f.owner.restoreImageRefs?.has(ref), true);
});
test("a new real user turn can continue after a capacity rejection without changing the old ToolPart or original", async () => {
  const { f, ref } = await restoredFixture();
  const oldTool = f.entries.findLast((entry) => entry.message.role === "tool")!;
  const oldPart = structuredClone(f.messages.get(oldTool.canonical!.messageId));
  const oldReceipts = structuredClone(f.state.imageReceipts);
  await assert.rejects(prepareNativeContextImages(f.runtime, f.request({ maxRawBytes: 3072 })), {
    code: "too_large",
  });
  f.addText("after-capacity-rejection");
  const input = f.request({ maxRawBytes: 3072 });
  const before = structuredClone(f.state);
  const result = await prepareNativeContextImages(f.runtime, input);
  assert.deepEqual(result.imageChanges.restoredRefs, []);
  assert.ok(images(result).length > 0);
  assert.ok(
    images(result).every(
      (image) => Buffer.from(image.dataUrl.split(",")[1]!, "base64").length <= 3072,
    ),
  );
  assert.deepEqual(f.messages.get(oldTool.canonical!.messageId), oldPart);
  assert.deepEqual(f.state, before);
  assert.deepEqual(f.state.imageReceipts, oldReceipts);
  assert.equal(f.owner.restoreImageRefs?.has(ref), true);
  const original = await readNativeContextImage.call(f.runtime, {
    ref,
    expectedRevision: f.state.revision,
  });
  assert.deepEqual(Buffer.from(original.dataBase64!, "base64"), pngHeaderBytes());
});
test("a new real user turn can continue after an unsupported-model restore with ordinary historical images", async () => {
  const { f, ref } = await restoredFixture();
  await assert.rejects(
    prepareNativeContextImages(f.runtime, f.request({ model: imageModel("text-model", false) })),
    /model-image-capability/u,
  );
  f.addText("after-capability-rejection");
  const result = await prepareNativeContextImages(f.runtime, f.request());
  assert.deepEqual(result.imageChanges.restoredRefs, []);
  assert.ok(images(result).length > 0);
  assert.equal(f.owner.restoreImageRefs?.has(ref), true);
});
test("synthetic carriers and another entry of the same real input do not expire an exact restore retry", async () => {
  const { f, ref } = await restoredFixture();
  f.addText("later-synthetic-carrier").metadata = { source: "shared_context" };
  f.addText("latest");
  await assert.rejects(prepareNativeContextImages(f.runtime, f.request({ maxRawBytes: 3072 })), {
    code: "too_large",
  });
  assert.equal(f.owner.restoreImageRefs?.has(ref), true);
});
test("a proved restore on a model without image support is an explicit capability failure", async () => {
  const { f, ref } = await restoredFixture(),
    count = f.commits.length;
  await assert.rejects(
    prepareNativeContextImages(f.runtime, f.request({ model: imageModel("text-model", false) })),
    /model-image-capability/u,
  );
  assert.equal(f.owner.restoreImageRefs?.has(ref), true);
  assert.equal(f.commits.length, count);
});
test("source string and matching bytes cannot substitute for a real completed context_read_image tool", async () => {
  const f = imageFixture();
  f.addImage("old");
  f.addText("latest");
  const first = await completed(f);
  const ref = first.sentImages[0]!.ref;
  f.addRestore(ref, false);
  const result = await prepareNativeContextImages(f.runtime, f.request());
  assert.deepEqual(result.imageChanges.restoredRefs, []);
  assert.equal(f.owner.restoreImageRefs?.has(ref), true);
  assert.equal(f.calls.length, 2);
});
test("CAS failure preserves restoration intent and no restored view is committed until retry succeeds", async () => {
  const { f, ref } = await restoredFixture();
  const input = f.request(),
    result = await prepareNativeContextImages(f.runtime, input),
    before = structuredClone(f.state);
  for (const receipt of result.sentImages) receipt.logicalRequestId = "restored-request";
  f.complete(input);
  f.rejectNextCommit();
  await assert.rejects(
    commitNativeImageReceipts(f.runtime, result.sentImages, input.comparison),
    /CAS rejection/u,
  );
  assert.deepEqual(f.state, before);
  assert.equal(f.owner.restoreImageRefs?.has(ref), true);
  await commitNativeImageReceipts(f.runtime, result.sentImages, input.comparison);
  assert.equal(f.owner.restoreImageRefs?.has(ref), false);
});
test("a final-gate removed restore does not consume intent or persist its sending view", async () => {
  const { f, ref } = await restoredFixture();
  const input = f.request(),
    result = await prepareNativeContextImages(f.runtime, input),
    restored = result.sentImages[0]!.ref;
  result.sentImages.splice(0);
  f.complete(input);
  const count = f.commits.length;
  await commitNativeImageReceipts(f.runtime, result.sentImages, input.comparison);
  assert.equal(f.commits.length, count);
  assert.equal(f.owner.restoreImageRefs?.has(ref), true);
  assert.equal(kernelOf(f.state).imageViews?.[restored], undefined);
});
