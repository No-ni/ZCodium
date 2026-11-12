import assert from "node:assert/strict";
import test from "node:test";
import { createMessageId, createPartId, NativeContextStoreConflictError } from "@zcode/contracts";
import {
  emptyNativeContextImageMeasurement,
  type NativeContextStatus,
} from "@zcode/shared/native-context-compression";
import {
  buildNativeContextForkBundle,
  recoverNativeContext,
  rebaseNativeContext,
  resetNativeContextAfterCompact,
} from "../src/runtime/native-context-compression/boundaries.js";
import {
  kernelOf,
  nativeOwner,
  writeNativeState,
} from "../src/runtime/native-context-compression/state.js";
import { syncNativeSources } from "../src/runtime/native-context-compression/sources.js";
import {
  block,
  CHILD,
  compactMessage,
  commit,
  countTokens,
  fixture,
  HASH,
  observation,
  operation,
  PARENT,
  refs,
  rewind,
} from "./native-context-boundary-fixture.js";

test("cold rewind reattaches frozen prefix facts and removes all future source membership", async (t) => {
  const { host, state, store, messages, events } = await fixture(t);
  const kernel = kernelOf(state);
  kernel.compression.blocks = [
    block("kept", ["msg_first#e0"]),
    block("crossing", ["msg_first#e0", "msg_future#e0"]),
    block("parent", ["msg_first#e0"], ["crossing"]),
  ];
  kernel.views = {
    "msg_first#e0": { kind: "reference", text: "合成引用", policyVersion: 3 },
    "msg_future#e0": { kind: "reference", text: "未来引用", policyVersion: 3 },
  };
  kernel.omittedReasoningIds = ["msg_first#e0", "msg_future#e0"];
  state.requestSeq = 3;
  const kept = observation("kept-point", {
    anchorMessageId: "msg_first",
    requestSeq: 1,
    status: "completed",
    actualInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    completedAt: 20,
  });
  const future = observation("future-point", { anchorMessageId: "msg_future", requestSeq: 3 });
  await commit(host, state, { observations: [kept, future], operations: [] });
  nativeOwner(host).state = state;
  nativeOwner(host).lastObservation = future;
  await rewind(host, messages, 2);
  await assert.rejects(store.getNativeContextForkBundle(PARENT), NativeContextStoreConflictError);
  await recoverNativeContext(host);
  const bundle = await store.getNativeContextForkBundle(PARENT);
  assert.ok(bundle);
  assert.deepEqual(bundle.observations, [kept]);
  assert.equal(bundle.state.generation, 1);
  assert.equal(bundle.state.revision, 1);
  assert.equal(bundle.state.requestSeq, 3);
  assert.equal(
    bundle.state.sources.some((source) => source.messageId === "msg_future"),
    false,
  );
  assert.equal(refs(bundle.state).byRaw["msg_future#e0"], undefined);
  assert.deepEqual(
    kernelOf(bundle.state).compression.blocks.map((item) => item.blockId),
    ["kept"],
  );
  assert.equal(kernelOf(bundle.state).views["msg_future#e0"], undefined);
  assert.equal(nativeOwner(host).lastObservation?.actualInputTokens, 0);
  assert.deepEqual(kernelOf(bundle.state).omittedReasoningIds, ["msg_first#e0"]);
  assert.equal(events.length, 1);
  assert.equal(
    (events[0] as { payload: NativeContextStatus }).payload.lastObservation?.id,
    kept.id,
  );
  const before = new Set(Object.values(refs(state).byRaw));
  syncNativeSources(
    bundle.state,
    [
      {
        message: { role: "user", content: "新分支" },
        canonical: { messageId: "new-input", createdAt: 30, entryIndex: 0 },
      },
    ],
    countTokens,
  );
  assert.equal(before.has(refs(bundle.state).byRaw["new-input#e0"]!), false);
});

test("one rewind CAS keeps more than 200 observations without rewriting their historical generation", async (t) => {
  const { host, state, store, messages } = await fixture(t);
  const points = Array.from({ length: 240 }, (_, index) =>
    observation(`prefix-${index}`, {
      anchorMessageId: "msg_first",
      requestSeq: index + 1,
      status: "completed",
      actualInputTokens: 10,
      completedAt: 20,
    }),
  );
  state.requestSeq = 241;
  await commit(host, state, {
    observations: [
      ...points,
      observation("msg_future", { anchorMessageId: "msg_future", requestSeq: 241 }),
    ],
    operations: [],
  });
  await rewind(host, messages, 2);
  let commits = 0;
  const originalCommit = store.commitNativeContext.bind(store);
  store.commitNativeContext = async (sessionId, input) => {
    commits += 1;
    assert.equal(input.observations?.length, 240);
    await originalCommit(sessionId, input);
  };
  await rebaseNativeContext(host);
  assert.equal(commits, 1);
  const bundle = await store.getNativeContextForkBundle(PARENT);
  assert.equal(bundle?.observations.length, 240);
  assert.deepEqual(bundle?.observations, points);
});

test("interrupted maintenance becomes obsolete without manufacturing usage or applying its candidate", async (t) => {
  const { host, state, store } = await fixture(t);
  const pending = operation("interrupted", {
    anchorMessageId: "msg_first",
    status: "running",
    observationIds: ["maintenance"],
    model: { providerId: "fixture-provider", modelId: "fixture-model" },
  });
  const measured = observation("maintenance", {
    anchorMessageId: "msg_first",
    purpose: "maintenance",
    operationIds: [pending.operationId],
    actualInputTokens: 12,
    status: "prepared",
    images: emptyNativeContextImageMeasurement(),
  });
  await commit(host, state, { observations: [measured], operations: [pending] });
  const owner = nativeOwner(host);
  const controller = new AbortController();
  owner.state = structuredClone(state);
  owner.phase = "compressing";
  owner.cancellation = controller;
  owner.pendingOperationIds = [pending.operationId];
  owner.restoreImageRefs = new Set(["old-ref"]);
  owner.commandResults = new Map([
    ["old-command", Promise.resolve({ status: "unavailable", reason: "busy" } as never)],
  ]);
  await recoverNativeContext(host);
  const bundle = await store.getNativeContextForkBundle(PARENT);
  assert.equal(controller.signal.aborted, true);
  assert.equal(owner.phase, "idle");
  assert.deepEqual(owner.pendingOperationIds, []);
  assert.equal(owner.restoreImageRefs.size, 0);
  assert.equal(owner.commandResults.size, 0);
  assert.equal(bundle?.operations[0]?.status, "obsolete");
  assert.equal(bundle?.observations[0]?.status, "obsolete");
  assert.equal(bundle?.observations[0]?.actualInputTokens, 12);
  assert.equal(bundle?.observations[0]?.outputTokens, null);
  assert.equal(kernelOf(bundle!.state).compression.blocks.length, 0);
});

test("compact cuts a segment and receipts but retains original sources and frozen main points", async (t) => {
  const { host, state, store, messages } = await fixture(t);
  kernelOf(state).compression.blocks = [block("old", ["msg_first#e0"])];
  kernelOf(state).views["msg_first#e0"] = { kind: "reference", text: "合成引用", policyVersion: 3 };
  kernelOf(state).omittedReasoningIds = ["msg_first#e0"];
  kernelOf(state).imageViews = {
    synthetic: {
      artifactUri: "zcode-artifact://fixture/attachment/view",
      mediaType: "image/png",
      policyHash: HASH,
      representationHash: HASH,
      bytes: 3,
    },
  };
  kernelOf(state).omittedImageRefs = ["synthetic"];
  const point = observation("before-compact", {
    anchorMessageId: "msg_first",
    status: "completed",
    actualInputTokens: 22,
    completedAt: 20,
  });
  await commit(host, state, { observations: [point], operations: [] });
  const summary = compactMessage();
  await store.commitMessageBundle({ sessionID: PARENT, messages: [summary] });
  const sourceBefore = structuredClone(state.sources);
  host.messageHistory.reset();
  host.messageHistory.addEntries([
    {
      message: { role: "user", content: "合成摘要" },
      canonical: {
        messageId: summary.info.id,
        partId: summary.parts[0]!.id,
        createdAt: 10,
        entryIndex: 0,
      },
    },
  ]);
  await resetNativeContextAfterCompact(host, "compact-boundary");
  const bundle = await store.getNativeContextForkBundle(PARENT);
  assert.ok(bundle);
  assert.equal(bundle.state.generation, 0);
  assert.equal(bundle.state.compactBoundaryId, "compact-boundary");
  assert.deepEqual(bundle.state.sources, sourceBefore);
  assert.deepEqual(refs(bundle.state), refs(state));
  assert.deepEqual(bundle.state.imageReceipts, []);
  assert.deepEqual(kernelOf(bundle.state).compression.blocks, []);
  assert.deepEqual(kernelOf(bundle.state).views, {});
  assert.deepEqual(kernelOf(bundle.state).omittedReasoningIds, []);
  assert.deepEqual(kernelOf(bundle.state).imageViews, {});
  assert.deepEqual(kernelOf(bundle.state).omittedImageRefs, []);
  assert.deepEqual(bundle.observations, [point]);
  const marker = bundle.operations.find((item) => item.kind === "compact-boundary");
  assert.equal(marker?.anchorMessageId, summary.info.id);
  assert.equal(marker?.beforeEstimate, null);
  assert.equal(marker?.afterEstimate, null);
  assert.equal(marker?.model, null);
  assert.deepEqual(marker?.observationIds, []);
  const revision = bundle.state.revision;
  await resetNativeContextAfterCompact(host, "compact-boundary");
  assert.equal((await store.getNativeContextState(PARENT))?.revision, revision);
  assert.equal((await store.getNativeContextForkBundle(PARENT))?.operations.length, 1);
  assert.equal(messages.length, 3);
});

test("resume repairs a persisted summary/native-reset interruption and leaves past originals queryable", async (t) => {
  const { host, state, store } = await fixture(t);
  kernelOf(state).compression.blocks = [block("old", ["msg_first#e0"])];
  await commit(host, state);
  await store.commitMessageBundle({ sessionID: PARENT, messages: [compactMessage()] });
  host.messageHistory.reset();
  host.messageHistory.addEntries([
    {
      message: { role: "user", content: "合成摘要" },
      canonical: { messageId: "msg_compact-summary", entryIndex: 0, createdAt: 10 },
    },
  ]);
  await recoverNativeContext(host);
  const saved = await store.getNativeContextState(PARENT);
  assert.equal(saved?.compactBoundaryId, "compact-boundary");
  assert.equal(kernelOf(saved!).compression.blocks.length, 0);
  assert.ok(saved?.sources.find((source) => source.messageId === "msg_first"));
  assert.equal(saved?.imageReceipts.length, 0);
});

test("legacy resume initializes manual at its real compact boundary without backfilling facts", async (t) => {
  const { host, store } = await fixture(t, [compactMessage()]);
  await recoverNativeContext(host);
  const bundle = await store.getNativeContextForkBundle(PARENT);
  assert.equal(bundle?.state.policy.mode, "manual");
  assert.equal(bundle?.state.compactBoundaryId, "compact-boundary");
  assert.deepEqual(bundle?.operations, []);
  assert.deepEqual(bundle?.observations, []);
});

test("fork maps complete canonical sources and inherited facts without copying future coverage", async (t) => {
  const { host, state, store } = await fixture(t);
  kernelOf(state).compression.blocks = [
    block("kept", ["msg_first#e0"]),
    block("crossing", ["msg_first#e0", "msg_future#e0"]),
  ];
  kernelOf(state).omittedReasoningIds = ["msg_first#e0", "msg_future#e0"];
  kernelOf(state).policyCommands = {
    inheritedCommand: { expectedVersion: 2, configurationHash: HASH, policyVersion: 3 },
  };
  state.policy.mode = "auto";
  state.policy.parameters.images.maxEdge = 1800;
  const source = state.sources.find((item) => item.messageId === "msg_first")!;
  const keptOperation = operation("kept-operation", {
    anchorMessageId: "msg_first",
    anchorRequestSeq: 1,
    status: "completed",
    completedAt: 20,
    sources: [
      {
        ref: source.ref,
        messageId: source.messageId,
        partId: source.partId,
        imageIndex: null,
        kind: "text",
        originalAvailable: true,
      },
    ],
  });
  const point = observation("kept", {
    anchorMessageId: "msg_first",
    requestSeq: 1,
    status: "completed",
    completedAt: 20,
    operationIds: [keptOperation.operationId],
  });
  const futureOperation = operation("future-operation", {
    anchorMessageId: "msg_future",
    status: "completed",
    completedAt: 20,
  });
  await commit(host, state, {
    observations: [point, observation("msg_future", { anchorMessageId: "msg_future" })],
    operations: [keptOperation, futureOperation],
  });
  const bundle = await buildNativeContextForkBundle(
    host,
    {
      childSessionId: CHILD,
      messageIds: new Map([
        ["msg_first", "msg_child-first"],
        ["msg_response", "msg_child-response"],
      ]),
      partIds: new Map([
        ["part_first-text", "part_child-first-text"],
        ["part_response-text", "part_child-response-text"],
      ]),
      toolCallIds: new Map(),
    },
    ["msg_first", "msg_response"],
  );
  assert.ok(bundle);
  assert.equal(bundle.state.revision, 0);
  assert.equal(bundle.state.generation, 0);
  assert.equal(bundle.state.policy.parameters.images.maxEdge, 1800);
  assert.equal(bundle.state.policy.policyVersion, 3);
  assert.equal(
    bundle.state.sources.every((item) => item.messageId.startsWith("msg_child-")),
    true,
  );
  assert.equal(bundle.state.sources[0]?.partId, "part_child-first-text");
  assert.equal(bundle.state.sources[0]?.firstSeenAt, source.firstSeenAt);
  assert.equal(bundle.state.sources[0]?.tokenSnapshot, source.tokenSnapshot);
  assert.deepEqual(
    kernelOf(bundle.state).compression.blocks.map((item) => item.blockId),
    ["kept"],
  );
  assert.deepEqual(kernelOf(bundle.state).compression.blocks[0]?.effectiveMessageIds, [
    "msg_child-first#e0",
  ]);
  assert.deepEqual(kernelOf(bundle.state).omittedReasoningIds, ["msg_child-first#e0"]);
  assert.equal(kernelOf(bundle.state).policyCommands, undefined);
  assert.equal(bundle.observations.length, 1);
  assert.equal(bundle.observations[0]?.origin, "inherited");
  assert.equal(bundle.observations[0]?.generation, point.generation);
  assert.equal(bundle.observations[0]?.historyVersion, point.historyVersion);
  assert.equal(bundle.observations[0]?.usageRecordRef, point.usageRecordRef);
  assert.notEqual(bundle.observations[0]?.id, point.id);
  assert.notEqual(bundle.observations[0]?.logicalRequestId, point.logicalRequestId);
  assert.equal(bundle.operations[0]?.anchorMessageId, "msg_child-first");
  assert.equal(bundle.operations[0]?.sources[0]?.partId, "part_child-first-text");
  assert.deepEqual(bundle.observations[0]?.operationIds, [bundle.operations[0]?.operationId]);
  assert.deepEqual(await store.getNativeContextState(PARENT), state);
});

test("fork refuses an unverified prefix or missing real part mapping", async (t) => {
  const { host, state } = await fixture(t);
  await commit(host, state);
  const maps = {
    childSessionId: CHILD,
    messageIds: new Map([["msg_first", "msg_child-first"]]),
    partIds: new Map<string, string>(),
    toolCallIds: new Map<string, string>(),
  };
  await assert.rejects(buildNativeContextForkBundle(host, maps, ["msg_future"]), /fork-prefix/u);
  await assert.rejects(buildNativeContextForkBundle(host, maps, ["msg_first"]), /fork-part/u);
});

test("failed rewind native commit keeps the prior stored state and supports a later cold retry", async (t) => {
  const { host, state, store, messages } = await fixture(t);
  await commit(host, state);
  await rewind(host, messages, 2);
  const originalCommit = store.commitNativeContext.bind(store);
  store.commitNativeContext = async () => {
    throw new Error("synthetic commit failure");
  };
  await assert.rejects(rebaseNativeContext(host), /synthetic commit failure/u);
  assert.deepEqual(await store.getNativeContextState(PARENT), state);
  store.commitNativeContext = originalCommit;
  await recoverNativeContext(host);
  assert.equal((await store.getNativeContextState(PARENT))?.generation, 1);
});

test("rewind retains receipts only for kept canonical image and committed assistant response", async (t) => {
  const { host, state, store, messages } = await fixture(t);
  const rawId = "msg_first#e0:image0";
  const ref = "m00010";
  const imagePart = createPartId("image-part");
  messages[0]!.parts.push({
    id: imagePart,
    messageID: createMessageId("first"),
    sessionID: PARENT,
    type: "file",
    mime: "image/png",
    url: "data:image/png;base64,aW1hZ2U=",
    metadata: { image: { originalArtifactUri: `zcode-artifact://${PARENT}/attachment/image` } },
  });
  await store.commitMessageBundle({ sessionID: PARENT, messages: [messages[0]!] });
  const base = state.sources[0]!;
  state.sources.push({
    ...base,
    rawId,
    ref,
    kind: "image",
    partId: imagePart,
    imageIndex: 0,
    artifactUri: `zcode-artifact://${PARENT}/attachment/image`,
    originalBytes: 5,
  });
  refs(state).byRaw[rawId] = ref;
  refs(state).byRef[ref] = rawId;
  const imageView = {
    artifactUri: `zcode-artifact://${PARENT}/attachment/image-view`,
    mediaType: "image/png",
    policyHash: HASH,
    representationHash: HASH,
    bytes: 3,
  };
  kernelOf(state).imageViews = { [ref]: imageView, futureRef: imageView };
  kernelOf(state).omittedImageRefs = [ref, "futureRef"];
  state.imageReceipts = [
    {
      ref,
      responseMessageId: "msg_response",
      logicalRequestId: "successful-request",
      modelKey: "fixture-model",
      policyHash: HASH,
      representationHash: HASH,
      generation: 0,
    },
    {
      ref,
      responseMessageId: "msg_future",
      logicalRequestId: "uncommitted-request",
      modelKey: "fixture-model",
      policyHash: HASH,
      representationHash: HASH,
      generation: 0,
    },
  ];
  await commit(host, state);
  await rewind(host, messages, 2);
  await rebaseNativeContext(host);
  const bundle = await store.getNativeContextForkBundle(PARENT);
  assert.equal(bundle?.state.imageReceipts.length, 1);
  assert.equal(bundle?.state.imageReceipts[0]?.responseMessageId, "msg_response");
  assert.equal(bundle?.state.imageReceipts[0]?.generation, 1);
  assert.deepEqual(kernelOf(bundle!.state).imageViews, { [ref]: imageView });
  assert.deepEqual(kernelOf(bundle!.state).omittedImageRefs, [ref]);
});

test("a mixed main and maintenance commit publishes the last main observation", async (t) => {
  const { host, state, events } = await fixture(t);
  await commit(host, state);
  const owner = nativeOwner(host);
  owner.state = structuredClone(state);
  const main = observation("main", { anchorMessageId: "msg_first" });
  const maintenance = observation("maintenance-last", { purpose: "maintenance" });
  await writeNativeState(owner, () => {}, { observations: [main, maintenance] });
  assert.equal(owner.lastObservation?.id, main.id);
  assert.equal(events.length, 1);
  assert.equal(
    (events[0] as { payload: NativeContextStatus }).payload.lastObservation?.id,
    main.id,
  );
});
