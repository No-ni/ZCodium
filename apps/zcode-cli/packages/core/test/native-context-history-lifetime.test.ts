import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { createMessageId, createPartId } from "@zcode/contracts";
import { NodeToolArtifactStore } from "@zcode/adapters/storage";
import { createProjectTestFixture } from "../../../../../scripts/ci/project-test-sandbox.mjs";
import { originalImageToStorageMetadata } from "../src/media/original-image/index.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { rewindConversationToMessage } from "../src/runtime/methods/rewind-message.js";
import { forkConversationFromMessage } from "../src/runtime/methods/session-fork.js";
import {
  getNativeContextCompression,
  readNativeContextImage,
  readNativeContextSource,
} from "../src/runtime/native-context-compression/index.js";
import { nativeHash } from "../src/runtime/native-context-compression/identity.js";
import { kernelOf, nativeOwner } from "../src/runtime/native-context-compression/state.js";
import { maintenanceGoalFixture } from "./native-context-maintenance-goal-fixture.js";
import { CHILD, commit, fixture, PARENT, refs } from "./native-context-boundary-fixture.js";

test("editing a long prompt after character 200 uses the real rewind boundary and a new canonical source", async (t) => {
  const f = await maintenanceGoalFixture(t);
  const original = f.messages[0]!;
  const originalPart = original.parts.find((part) => part.type === "text")!;
  assert.equal(originalPart.type, "text");
  if (originalPart.type !== "text") return;
  const changed = originalPart.text.slice(0, -80) + "Synthetic edited tail after character 200.";
  assert.ok(changed.length > 400);
  assert.equal(changed.slice(0, 200), originalPart.text.slice(0, 200));
  assert.notEqual(nativeHash(changed), nativeHash(originalPart.text));
  await f.manual("native-long-edit-initial-summary");
  const before = await getNativeContextCompression.call(f.runtime);
  const oldState = f.owner.state!;
  const oldRef = oldState.sources.find((source) => source.messageId === original.info.id)!.ref;
  assert.ok(kernelOf(oldState).compression.blocks.length > 0);
  const rewind = await rewindConversationToMessage.call(f.runtime, {
    targetMessageId: original.info.id,
    events: [],
    traceContext: f.runtime.rootTraceContext,
  });
  assert.equal(rewind.keptMessageCount, 0);
  assert.equal(f.runtime.branchGeneration, 1);
  await f.runtime.executeTurnCommand(changed, undefined, {
    inputId: "native-long-edit-replacement",
    skipUserPromptSubmitHooks: true,
    traceContext: f.runtime.rootTraceContext,
  });
  const after = await getNativeContextCompression.call(f.runtime);
  assert.notEqual(after.historyVersion, before.historyVersion);
  assert.ok(after.revision > before.revision);
  assert.equal(kernelOf(f.owner.state!).compression.blocks.length, 0);
  const source = f.owner.state!.sources.find((item) => item.contentHash === nativeHash(changed));
  assert.ok(source);
  assert.notEqual(source.messageId, original.info.id);
  assert.notEqual(source.ref, oldRef);
  assert.equal(
    f.owner.state!.sources.some((item) => item.messageId === original.info.id),
    false,
  );
  const page = await readNativeContextSource.call(f.runtime, {
    ref: source.ref,
    limitTokens: 25000,
  });
  assert.equal(page.originalAvailable, true);
  assert.equal(page.text, changed);
  await assert.rejects(
    readNativeContextSource.call(f.runtime, { ref: oldRef, expectedRevision: before.revision }),
    /stale-view|revision/u,
  );
  const persistedOriginal = await f.store.messageWithParts({
    sessionID: PARENT,
    messageID: original.info.id,
  });
  assert.equal(
    persistedOriginal?.parts.find((part) => part.type === "text")?.text,
    originalPart.text,
  );
  const main = f.invocations.findLast((item) => item.querySource !== "native_context_maintenance")!;
  assert.ok(JSON.stringify(main.call.request.messages).includes(changed));
});

test("a fork still reads its inherited original bytes and hash after the parent is soft deleted", async (t) => {
  const { host, store, state, messages } = await fixture(t);
  const directory = await createProjectTestFixture("native-fork-original-lifetime");
  const artifactStore = new NodeToolArtifactStore({
    rootDir: join(directory, "artifacts"),
    imageCacheRootDir: join(directory, "images"),
    videoCacheRootDir: join(directory, "videos"),
    pdfCacheRootDir: join(directory, "pdf"),
  });
  // 合成的有效 1×1 PNG：只证明原字节生命周期，不冒充大图编解码验收。
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jHdQAAAAASUVORK5CYII=",
    "base64",
  );
  const hash = nativeHash(bytes);
  const artifact = await artifactStore.writeToolResultBinaryArtifact({
    sessionId: PARENT,
    toolCallId: "native-original-lifetime",
    toolName: "fixture-image",
    content: bytes,
    contentType: "image/png",
    trace: host.rootTraceContext,
  });
  host.artifactStore = artifactStore;
  const imagePartId = createPartId("lifetime-original-image");
  messages[0]!.parts.push({
    id: imagePartId,
    sessionID: PARENT,
    messageID: messages[0]!.info.id,
    type: "file",
    mime: "image/png",
    url: "data:image/png;base64," + bytes.toString("base64"),
    metadata: {
      image: originalImageToStorageMetadata({
        artifactUri: artifact.uri,
        sha256: hash,
        bytes: bytes.length,
        mediaType: "image/png",
        sourceKind: "attachment",
        width: 1,
        height: 1,
        preserveRaster: true,
      }),
    },
  });
  await store.commitMessageBundle({ sessionID: PARENT, messages: [messages[0]!] });
  const imageRawId = "msg_first#e0:image0",
    imageRef = "m00010";
  state.sources.push({
    ...state.sources[0]!,
    rawId: imageRawId,
    ref: imageRef,
    partId: imagePartId,
    imageIndex: 0,
    kind: "image",
    sourceKind: "attachment",
    artifactUri: artifact.uri,
    contentHash: hash,
    originalBytes: bytes.length,
    width: 1,
    height: 1,
    originalAvailable: true,
  });
  refs(state).byRaw[imageRawId] = imageRef;
  refs(state).byRef[imageRef] = imageRawId;
  await commit(host, state);
  await forkConversationFromMessage.call(host, {
    forkedSessionId: CHILD,
    targetMessageId: createMessageId("response"),
    traceContext: host.rootTraceContext,
  });
  await store.softDeleteSession(PARENT);
  assert.ok((await store.listArtifactReferrers([PARENT])).get(PARENT)?.includes(CHILD));
  const bundle = await store.getNativeContextForkBundle(CHILD);
  assert.ok(bundle);
  const child = { ...host, sessionId: CHILD, branchGeneration: 0 } as AgentRuntimeInternal;
  nativeOwner(child).state = bundle.state;
  const source = bundle.state.sources.find((item) => item.kind === "image")!;
  assert.notEqual(source.partId, imagePartId);
  const page = await readNativeContextImage.call(child, { ref: source.ref, maxBytes: 32 });
  assert.equal(page.originalAvailable, true);
  assert.equal(page.originalBytes, bytes.length);
  assert.equal(page.nextOffset, 32);
  const tail = await readNativeContextImage.call(child, {
    ref: source.ref,
    offset: page.nextOffset!,
  });
  assert.equal(tail.nextOffset, null);
  const recovered = Buffer.concat([
    Buffer.from(page.dataBase64!, "base64"),
    Buffer.from(tail.dataBase64!, "base64"),
  ]);
  assert.equal(nativeHash(recovered), hash);
  assert.deepEqual(recovered, bytes);
});
