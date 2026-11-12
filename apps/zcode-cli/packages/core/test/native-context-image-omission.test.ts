import assert from "node:assert/strict";
import { test } from "node:test";
import { imageFixture, imageModel } from "./native-context-image-fixture.js";
import {
  commitNativeImageReceipts,
  prepareNativeContextImages,
} from "../src/runtime/native-context-compression/images.js";
import { kernelOf } from "../src/runtime/native-context-compression/state.js";

type Fixture = ReturnType<typeof imageFixture>;

async function deliver(f: Fixture) {
  const request = f.request();
  const result = await prepareNativeContextImages(f.runtime, request);
  for (const receipt of result.sentImages)
    receipt.logicalRequestId = "delivered-" + request.assistantMessageId;
  f.complete(request);
  await commitNativeImageReceipts(f.runtime, result.sentImages, request.comparison);
  return result;
}

function images(result: Awaited<ReturnType<typeof prepareNativeContextImages>>) {
  return result.messages.flatMap((message) =>
    Array.isArray(message.content) ? message.content.filter((block) => block.type === "image") : [],
  );
}

async function omittedFixture() {
  const f = imageFixture();
  Object.assign(f.state.policy.parameters.images, { omitSeen: true, foldWithHistory: false });
  f.addImage("old");
  f.addText("latest");
  const delivered = await deliver(f);
  const ref = delivered.sentImages[0]!.ref;
  const omitted = await deliver(f);
  assert.equal(images(omitted).length, 0);
  assert.deepEqual(kernelOf(f.state).omittedImageRefs, [ref]);
  return { f, ref, receipt: delivered.sentImages[0]! };
}

test("auto disabling omitSeen restores an eligible image from a committed omission", async () => {
  const { f, ref } = await omittedFixture();
  f.state.policy.parameters.images.omitSeen = false;
  f.state.policy.policyVersion++;
  const result = await prepareNativeContextImages(f.runtime, f.request());
  assert.equal(images(result).length, 1);
  assert.equal(result.sentImages[0]!.ref, ref);
  assert.deepEqual(result.imageChanges.omittedRefs, []);
  // 只准备请求不能清持久 latch，实际成功提交由同一 owner 完成。
  assert.deepEqual(kernelOf(f.state).omittedImageRefs, [ref]);
});

test("auto changing the target model does not reuse a committed omission proof", async () => {
  const { f, ref, receipt } = await omittedFixture();
  const result = await prepareNativeContextImages(
    f.runtime,
    f.request({ model: imageModel("new-model") }),
  );
  assert.equal(images(result).length, 1);
  assert.equal(result.sentImages[0]!.ref, ref);
  assert.equal(result.sentImages[0]!.modelKey, "fixture-provider/new-model");
  assert.notEqual(result.sentImages[0]!.policyHash, receipt.policyHash);
  assert.deepEqual(result.imageChanges.omittedRefs, []);
});

test("auto changing the encoding policy recomputes a previously omitted representation", async () => {
  const { f, ref, receipt } = await omittedFixture();
  f.state.policy.parameters.images.jpegQuality = 81;
  f.state.policy.policyVersion++;
  const before = f.calls.length;
  const result = await prepareNativeContextImages(f.runtime, f.request());
  assert.equal(images(result).length, 1);
  assert.equal(result.sentImages[0]!.ref, ref);
  assert.notEqual(result.sentImages[0]!.policyHash, receipt.policyHash);
  assert.equal(f.calls.length, before + 1);
  assert.equal(f.calls.at(-1)!.nativeContextPolicy!.jpegQuality, 81);
  assert.deepEqual(result.imageChanges.omittedRefs, []);
});

test("manual keeps a committed omission despite policy and model changes", async () => {
  const { f, ref } = await omittedFixture();
  f.state.policy.mode = "manual";
  f.state.policy.parameters.images.omitSeen = false;
  f.state.policy.parameters.images.jpegQuality = 81;
  f.state.policy.policyVersion++;
  const before = f.calls.length;
  const result = await prepareNativeContextImages(
    f.runtime,
    f.request({ model: imageModel("new-model") }),
  );
  assert.equal(images(result).length, 0);
  assert.equal(result.sentImages.length, 0);
  assert.equal(f.calls.length, before);
  assert.deepEqual(result.imageChanges.omittedRefs, [ref]);
});

test("a successful auto resend clears only its old omission before switching to manual", async () => {
  const { f } = await omittedFixture();
  f.state.policy.parameters.images.omitSeen = false;
  f.state.policy.policyVersion++;
  await deliver(f);
  assert.deepEqual(kernelOf(f.state).omittedImageRefs, []);
  f.state.policy.mode = "manual";
  f.state.policy.policyVersion++;
  const before = f.calls.length;
  const result = await prepareNativeContextImages(f.runtime, f.request());
  assert.equal(images(result).length, 1);
  assert.equal(f.calls.length, before);
  assert.deepEqual(result.imageChanges.omittedRefs, []);
});

test("a cancelled auto resend does not clear the last successfully committed omission", async () => {
  const { f, ref } = await omittedFixture();
  f.state.policy.parameters.images.omitSeen = false;
  f.state.policy.policyVersion++;
  const request = f.request();
  const result = await prepareNativeContextImages(f.runtime, request);
  for (const receipt of result.sentImages) receipt.logicalRequestId = "cancelled-resend";
  f.complete(request, { reason: "cancelled" });
  await commitNativeImageReceipts(f.runtime, result.sentImages, request.comparison);
  assert.deepEqual(kernelOf(f.state).omittedImageRefs, [ref]);
});
