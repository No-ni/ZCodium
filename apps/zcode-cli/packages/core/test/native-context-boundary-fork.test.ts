import assert from "node:assert/strict";
import test from "node:test";
import {
  createMessageId,
  createPartId,
  SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
} from "@zcode/contracts";
import { forkConversationFromMessage } from "../src/runtime/methods/session-fork.js";
import { kernelOf } from "../src/runtime/native-context-compression/state.js";
import {
  CHILD,
  commit,
  fixture,
  HASH,
  observation,
  PARENT,
  refs,
} from "./native-context-boundary-fixture.js";

test("legacy conversation fork commits inherited native state and the prefix-derived Goal in one bundle", async (t) => {
  for (const keepPassingVerifier of [false, true]) {
    await t.test(`kept passing verifier: ${keepPassingVerifier}`, async (subtest) => {
      const { host, state, store } = await fixture(subtest);
      const goal = await store.setTarget({
        sessionID: PARENT,
        objective: "合成目标",
        status: "complete",
      });
      await store.saveSessionEntry({
        id: "goal-verifier",
        sessionID: PARENT,
        type: SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
        time: { created: 10, updated: 20 },
        data: {
          eventId: "fixture-event",
          payload: {
            targetId: goal.targetID,
            verificationId: "fixture-verification",
            status: "completed",
            verification: { passed: true },
            anchorAssistantMessageId: keepPassingVerifier ? "msg_response" : "msg_future",
          },
        },
      });
      const point = observation("prefix", {
        anchorMessageId: "msg_first",
        status: "completed",
        actualInputTokens: 40,
        completedAt: 20,
      });
      await commit(host, state, { observations: [point], operations: [] });
      let calls = 0;
      const originalCommit = store.commitForkBundle.bind(store);
      store.commitForkBundle = async (bundle) => {
        calls += 1;
        assert.ok(bundle.nativeContext);
        assert.equal(bundle.goal?.status, keepPassingVerifier ? "complete" : "active");
        assert.equal(bundle.nativeContext.observations[0]?.origin, "inherited");
        return await originalCommit(bundle);
      };
      const result = await forkConversationFromMessage.call(host, {
        forkedSessionId: CHILD,
        targetMessageId: createMessageId("response"),
        traceContext: host.rootTraceContext,
      });
      assert.equal(calls, 1);
      assert.equal(result.forkedSessionId, CHILD);
      const inherited = await store.getNativeContextForkBundle(CHILD);
      assert.equal(inherited?.observations.length, 1);
      assert.equal(inherited?.observations[0]?.actualInputTokens, 40);
      assert.equal(inherited?.state.revision, 0);
      assert.equal(
        (await store.readTarget({ sessionID: CHILD }))?.status,
        keepPassingVerifier ? "complete" : "active",
      );
      const childMessages = await store.messages({ sessionID: CHILD });
      const childMessageIds = new Set(childMessages.map((item) => String(item.info.id)));
      assert.ok(inherited?.state.sources.every((source) => childMessageIds.has(source.messageId)));
      assert.equal(
        childMessages.some((item) =>
          item.parts.some((part) => part.type === "text" && part.text.includes("future")),
        ),
        false,
      );
    });
  }
});

test("runtime conversation fork failure after native rows leaves no partial child", async (t) => {
  const { host, state, store } = await fixture(t, undefined, {
    forkCommitFaultAt: "afterNativeContext",
  });
  await commit(host, state);
  await assert.rejects(
    forkConversationFromMessage.call(host, {
      forkedSessionId: CHILD,
      targetMessageId: createMessageId("response"),
      traceContext: host.rootTraceContext,
    }),
    /injected fork commit fault/u,
  );
  assert.equal(await store.getSession(CHILD), null);
  assert.equal(await store.getNativeContextState(CHILD), null);
  assert.deepEqual(await store.messages({ sessionID: CHILD }), []);
  assert.deepEqual(await store.getNativeContextState(PARENT), state);
});

test("the atomic runtime fork remaps real image parts and receipts while protecting the inherited original", async (t) => {
  const { host, state, store, messages } = await fixture(t);
  const imagePartId = createPartId("original-image-part");
  const artifactUri = `zcode-artifact://${PARENT}/attachment/original-image`;
  messages[0]!.parts.push({
    id: imagePartId,
    messageID: messages[0]!.info.id,
    sessionID: PARENT,
    type: "file",
    mime: "image/png",
    url: "data:image/png;base64,aW1hZ2U=",
    metadata: { image: { originalArtifactUri: artifactUri, preserveRaster: true } },
  });
  await store.commitMessageBundle({ sessionID: PARENT, messages: [messages[0]!] });
  const rawId = "msg_first#e0:image0";
  const ref = "m00010";
  state.sources.push({
    ...state.sources[0]!,
    rawId,
    ref,
    kind: "image",
    partId: imagePartId,
    imageIndex: 0,
    artifactUri,
    originalBytes: 5,
  });
  refs(state).byRaw[rawId] = ref;
  refs(state).byRef[ref] = rawId;
  const imageView = {
    artifactUri: `zcode-artifact://${PARENT}/attachment/sent-copy`,
    mediaType: "image/png",
    policyHash: HASH,
    representationHash: HASH,
    bytes: 3,
  };
  kernelOf(state).imageViews = { [ref]: imageView };
  kernelOf(state).omittedImageRefs = [ref];
  state.imageReceipts = [
    {
      ref,
      responseMessageId: "msg_response",
      logicalRequestId: "parent-image-request",
      modelKey: "fixture-model",
      policyHash: HASH,
      representationHash: HASH,
      generation: 0,
    },
  ];
  await commit(host, state);
  await forkConversationFromMessage.call(host, {
    forkedSessionId: CHILD,
    targetMessageId: createMessageId("response"),
    traceContext: host.rootTraceContext,
  });
  const bundle = await store.getNativeContextForkBundle(CHILD);
  assert.ok(bundle);
  const source = bundle.state.sources.find((item) => item.kind === "image")!;
  assert.notEqual(source.messageId, "msg_first");
  assert.notEqual(source.partId, imagePartId);
  assert.equal(source.artifactUri, artifactUri);
  const receipt = bundle.state.imageReceipts[0]!;
  assert.notEqual(receipt.responseMessageId, "msg_response");
  assert.notEqual(receipt.logicalRequestId, "parent-image-request");
  assert.equal(receipt.ref, ref);
  assert.deepEqual(kernelOf(bundle.state).imageViews, { [ref]: imageView });
  assert.deepEqual(kernelOf(bundle.state).omittedImageRefs, [ref]);
  const copiedFile = (
    await store.messageWithParts({ sessionID: CHILD, messageID: source.messageId as never })
  )?.parts.find((part) => part.id === source.partId);
  assert.equal(copiedFile?.type, "file");
  if (copiedFile?.type === "file") {
    const metadata = copiedFile.metadata as
      | { image?: { originalArtifactUri?: string } }
      | undefined;
    assert.equal(metadata?.image?.originalArtifactUri, artifactUri);
  }
  assert.ok((await store.listArtifactReferrers([PARENT])).get(PARENT)?.includes(CHILD));
});
