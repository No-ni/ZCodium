import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createImageProcessorError,
  parseImageDataUrl,
  type ModelImageContentBlock,
  type ModelInputMessage,
} from "@zcode/contracts";
import { NativeContextRuntimeError } from "../src/runtime/native-context-compression/contract.js";
import { prepareNativeMaintenanceMedia } from "../src/runtime/native-context-compression/maintenance-media.js";
import { kernelOf } from "../src/runtime/native-context-compression/state.js";
import {
  historyVersionOf,
  nativeHash,
} from "../src/runtime/native-context-compression/identity.js";
import { imageModel, pngHeaderBytes } from "./native-context-image-fixture.js";
import { maintenanceMediaFixture } from "./native-context-maintenance-media-fixture.js";

const imagesOf = (messages: ModelInputMessage[]): ModelImageContentBlock[] =>
  messages.flatMap((message) =>
    Array.isArray(message.content) ? message.content.filter((block) => block.type === "image") : [],
  );
const errorIs =
  (reason: string, code = "unavailable") =>
  (error: unknown) =>
    error instanceof NativeContextRuntimeError && error.code === code && error.reason === reason;

test("visual distillation sends each owned image beside its exact output and image ref", async () => {
  const f = maintenanceMediaFixture([2, 2]);
  const before = structuredClone(f.input.messages);
  const result = await prepareNativeMaintenanceMedia(f.native.runtime, f.input);
  assert.equal(imagesOf(result).length, 4);
  assert.deepEqual(f.input.messages, before);
  assert.equal(result[0], f.input.messages[0]);
  const content = result.at(-1)!.content;
  assert.ok(Array.isArray(content));
  assert.deepEqual(content[0], { type: "text", text: f.input.messages.at(-1)!.content });
  for (const output of f.input.outputs) {
    const sources = f.input.state.sources.filter((source) =>
      source.rawId.startsWith(output.rawId + ":image"),
    );
    for (const source of sources) {
      assert.ok(
        content.some(
          (block) =>
            block.type === "text" &&
            block.text.includes(JSON.stringify({ outputRef: output.ref, imageRef: source.ref })),
        ),
      );
    }
  }
  assert.equal(new Set(imagesOf(result).map((block) => block.source?.canonicalPartId)).size, 4);
  assert.equal(f.native.calls.length, 4);
  assert.ok(f.native.calls.every((call) => call.sourceKind === "read"));
});

test("immutable artifact bytes are used even when the canonical carrier URL is stale", async () => {
  const f = maintenanceMediaFixture();
  const entry = f.native.entries.find((item) => item.message.role === "tool")!;
  assert.ok(Array.isArray(entry.message.content));
  const block = entry.message.content.find((item) => item.type === "image")!;
  block.dataUrl = "data:image/png;base64," + Buffer.from("stale provider copy").toString("base64");
  f.native.sync();
  f.input.state = structuredClone(f.native.state);
  f.input.safePoint.entries = structuredClone(f.native.entries);
  f.input.outputs[0].entry = f.input.safePoint.entries.find(
    (item) => item.kind !== "attachment" && item.message.role === "tool",
  )!;
  await prepareNativeMaintenanceMedia(f.native.runtime, f.input);
  assert.deepEqual(Buffer.from(f.native.calls[0].data), pngHeaderBytes());
});

test("copy preparation leaves canonical bytes, sources, receipts and committed views unchanged", async () => {
  const f = maintenanceMediaFixture();
  const source = f.native.state.sources.find((item) => item.kind === "image")!;
  kernelOf(f.native.state).omittedImageRefs = [source.ref];
  f.native.state.imageReceipts.push({
    ref: source.ref,
    responseMessageId: "prior-response",
    logicalRequestId: "prior-request",
    modelKey: "prior/model",
    policyHash: "prior-policy",
    representationHash: source.contentHash,
    generation: f.native.state.generation,
  });
  f.input.state = structuredClone(f.native.state);
  const state = structuredClone(f.native.state),
    entries = structuredClone(f.native.entries);
  const original = Uint8Array.from(f.native.binaries.get(source.artifactUri!)!);
  f.native.setEncoder((request) => {
    request.data[30] = 0;
    return {
      data: pngHeaderBytes(1024, 512, 256),
      mediaType: "image/png",
      width: 512,
      height: 256,
      resized: true,
      compressed: true,
      strategy: "resized",
      originalSizeBytes: request.data.byteLength,
      transformedSizeBytes: 1024,
    };
  });
  const result = await prepareNativeMaintenanceMedia(f.native.runtime, f.input);
  assert.equal(
    imagesOf(result).length,
    1,
    "main-request omission and receipts do not suppress maintenance images",
  );
  assert.deepEqual(f.native.binaries.get(source.artifactUri!), original);
  assert.deepEqual(f.native.entries, entries);
  assert.deepEqual(f.native.state, state);
  assert.equal(f.native.commits.length, 0);
  assert.equal(f.native.events.length, 0);
  assert.equal(f.native.messages.has(f.input.operationId), false);
  assert.notEqual(
    nativeHash(parseImageDataUrl(imagesOf(result)[0].dataUrl)!.data),
    source.contentHash,
  );
});

test("pure text maintenance retains the original messages and performs no image IO", async () => {
  const f = maintenanceMediaFixture([0]);
  const result = await prepareNativeMaintenanceMedia(f.native.runtime, f.input);
  assert.equal(result, f.input.messages);
  assert.equal(f.native.calls.length, 0);
  assert.equal(f.native.writes.length, 0);
});

test("a nonvision maintenance model rejects the complete batch before processing", async () => {
  const f = maintenanceMediaFixture();
  f.input.model = imageModel("text-only", false);
  await assert.rejects(
    prepareNativeMaintenanceMedia(f.native.runtime, f.input),
    errorIs("maintenance-media-unsupported"),
  );
  assert.equal(f.native.calls.length, 0);
  assert.equal(f.native.writes.length, 0);
});

for (const missing of [
  "metadata",
  "attachment",
  "artifact",
  "hash",
  "source",
  "tool-owner",
] as const) {
  test(
    "unverified " + missing + " rejects visual distillation instead of sending only text",
    async () => {
      const f = maintenanceMediaFixture();
      const output = f.input.outputs[0];
      const message = f.native.messages.get(output.source.messageId)!;
      const part = message.parts.find((item) => item.type === "tool")!;
      assert.equal(part.type, "tool");
      assert.equal(part.state.status, "completed");
      if (part.state.status !== "completed") throw new Error("invalid fixture");
      const image = f.input.state.sources.find((item) => item.kind === "image")!;
      if (missing === "metadata") delete part.state.attachments![0].metadata;
      if (missing === "attachment") part.state.attachments = [];
      if (missing === "artifact") f.native.binaries.delete(image.artifactUri!);
      if (missing === "hash") f.native.binaries.set(image.artifactUri!, pngHeaderBytes(2048));
      if (missing === "source")
        f.input.state.sources = f.input.state.sources.filter((item) => item.kind !== "image");
      if (missing === "tool-owner") message.info.id = "different-message" as typeof message.info.id;
      await assert.rejects(
        prepareNativeMaintenanceMedia(f.native.runtime, f.input),
        errorIs("maintenance-media-source"),
      );
      assert.equal(f.native.calls.length, 0);
      assert.equal(f.native.commits.length, 0);
    },
  );
}

test("an oversized exact raster rejects the batch at the single-image hard budget", async () => {
  const f = maintenanceMediaFixture([1], pngHeaderBytes(4 * 1024 * 1024), true);
  await assert.rejects(
    prepareNativeMaintenanceMedia(f.native.runtime, f.input),
    errorIs("maintenance-media-capacity"),
  );
  assert.equal(f.native.calls.length, 0);
});

test("the protected 40MiB aggregate rejects the batch before processing subsequent images", async () => {
  const f = maintenanceMediaFixture([10], pngHeaderBytes(3.5 * 1024 * 1024));
  f.native.setEncoder((request) => ({
    data: request.data,
    mediaType: request.mediaType,
    resized: false,
    compressed: false,
    originalSizeBytes: request.data.byteLength,
    transformedSizeBytes: request.data.byteLength,
    strategy: "original",
  }));
  await assert.rejects(
    prepareNativeMaintenanceMedia(f.native.runtime, f.input),
    errorIs("maintenance-media-capacity"),
  );
  assert.equal(f.native.commits.length, 0);
  assert.equal(f.native.calls.length, 9);
});

test("a carried video cannot silently become text-only visual distillation", async () => {
  const f = maintenanceMediaFixture();
  const entry = f.input.outputs[0].entry;
  assert.notEqual(entry.kind, "attachment");
  if (entry.kind === "attachment" || !Array.isArray(entry.message.content))
    throw new Error("invalid fixture");
  entry.message.content.push({
    type: "video",
    mediaType: "video/mp4",
    dataUrl: "data:video/mp4;base64,AA==",
  });
  await assert.rejects(
    prepareNativeMaintenanceMedia(f.native.runtime, f.input),
    errorIs("maintenance-media-unsupported"),
  );
  assert.equal(f.native.calls.length, 0);
});

test("cancellation while the encoder is preparing a copy discards the media request", async () => {
  const f = maintenanceMediaFixture();
  const abort = new AbortController();
  f.input.safePoint.signal = abort.signal;
  f.native.setEncoder((request) => {
    abort.abort();
    return {
      data: request.data,
      mediaType: request.mediaType,
      resized: false,
      compressed: false,
      originalSizeBytes: request.data.byteLength,
      transformedSizeBytes: request.data.byteLength,
      strategy: "original",
    };
  });
  await assert.rejects(
    prepareNativeMaintenanceMedia(f.native.runtime, f.input),
    errorIs("maintenance-media-cancelled", "conflict"),
  );
  assert.equal(f.native.commits.length, 0);
  assert.equal(f.native.state.imageReceipts.length, 0);
});

test("output and image cardinality guards reject the batch before any artifact copy", async () => {
  for (const counts of [Array.from({ length: 21 }, () => 0), [201]]) {
    const f = maintenanceMediaFixture(counts);
    await assert.rejects(
      prepareNativeMaintenanceMedia(f.native.runtime, f.input),
      errorIs("maintenance-media-capacity"),
    );
    assert.equal(f.native.calls.length, 0);
    assert.equal(f.native.writes.length, 0);
  }
});

test("the supported 20 output / 200 image boundary preserves every image identity", async () => {
  const f = maintenanceMediaFixture(Array.from({ length: 20 }, () => 10));
  const result = await prepareNativeMaintenanceMedia(f.native.runtime, f.input);
  assert.equal(imagesOf(result).length, 200);
  assert.equal(new Set(imagesOf(result).map((block) => block.source?.canonicalPartId)).size, 200);
});

test("an unsupported encoder result remains a stable unsupported failure", async () => {
  const f = maintenanceMediaFixture();
  f.native.runtime.imageProcessorPort!.prepareForModel = async () => {
    throw createImageProcessorError({
      code: "unsupported",
      message: "synthetic unsupported image",
    });
  };
  await assert.rejects(
    prepareNativeMaintenanceMedia(f.native.runtime, f.input),
    errorIs("maintenance-media-unsupported"),
  );
});

for (const boundary of [
  "pre-cancel",
  "cancel-during-io",
  "policy",
  "policy-content",
  "history",
  "generation",
  "source-member",
] as const) {
  test(boundary + " invalidates the frozen media request without a state commit", async () => {
    const f = maintenanceMediaFixture();
    const abort = new AbortController();
    f.input.safePoint.signal = abort.signal;
    if (boundary === "pre-cancel") abort.abort();
    const originalRead = f.native.runtime.artifactStore!.readToolResultBinaryArtifact!.bind(
      f.native.runtime.artifactStore,
    );
    f.native.runtime.artifactStore!.readToolResultBinaryArtifact = async (request, options) => {
      const result = await originalRead(request, options);
      if (boundary === "cancel-during-io") abort.abort();
      if (boundary === "policy") f.native.state.policy.policyVersion++;
      if (boundary === "policy-content")
        f.native.state.policy.parameters.images.omitSeen =
          !f.native.state.policy.parameters.images.omitSeen;
      if (boundary === "history") f.native.state.historyVersion = "different-history";
      if (boundary === "generation") f.native.runtime.branchGeneration++;
      if (boundary === "source-member")
        f.native.state.sources = f.native.state.sources.filter((source) => source.kind !== "image");
      return result;
    };
    await assert.rejects(
      prepareNativeMaintenanceMedia(f.native.runtime, f.input),
      (error) => error instanceof NativeContextRuntimeError && error.code === "conflict",
    );
    assert.equal(f.native.commits.length, 0);
    assert.equal(f.native.calls.length, 0);
  });
}

test("actual canonical history drift is rejected even before its state fingerprint updates", async () => {
  const f = maintenanceMediaFixture();
  f.native.entries.find((entry) => entry.message.role === "tool")!.canonical!.imagePartIds = [
    "different-part",
  ];
  assert.equal(historyVersionOf(f.native.entries), f.input.state.historyVersion);
  await assert.rejects(
    prepareNativeMaintenanceMedia(f.native.runtime, f.input),
    (error) => error instanceof NativeContextRuntimeError && error.code === "conflict",
  );
});

test("operation-only revision updates are allowed while the frozen boundary is intact", async () => {
  const f = maintenanceMediaFixture();
  const originalRead = f.native.runtime.artifactStore!.readToolResultBinaryArtifact!.bind(
    f.native.runtime.artifactStore,
  );
  f.native.runtime.artifactStore!.readToolResultBinaryArtifact = async (request, options) => {
    const result = await originalRead(request, options);
    f.native.state.revision++;
    return result;
  };
  assert.equal(imagesOf(await prepareNativeMaintenanceMedia(f.native.runtime, f.input)).length, 1);
  assert.equal(f.native.commits.length, 0);
});
