import assert from "node:assert/strict";
import test from "node:test";
import { createMessageId, type ForkCommitBundle } from "@zcode/contracts";
import type { ForkCommitFaultStage } from "../src/storage/session-store/options.js";
import {
  CHILD_ID,
  HASH,
  PARENT_ID,
  conflict,
  memoryStore,
  message,
  observation,
  operation,
  sessionInput,
  source,
  state,
} from "./fixtures/native-context-store.js";

function forkBundle(): ForkCommitBundle {
  const copied = message(CHILD_ID);
  const copiedSource = source(copied);
  return {
    child: { ...sessionInput(CHILD_ID), parentID: PARENT_ID, taskType: "fork" },
    messages: [copied],
    entries: [],
    initialInput: {
      id: "child-input",
      sessionID: CHILD_ID,
      kind: "user",
      delivery: "queue",
      payload: { text: "合成分叉输入" },
    },
    commandFact: {
      parentSessionId: PARENT_ID,
      sourceCommandId: "fork-command",
      ack: {
        commandId: "fork-command",
        status: "accepted",
        revisionAtDecision: 1,
        result: { type: "forkAssistant", sessionId: CHILD_ID },
      },
      metadata: {},
    },
    nativeContext: {
      state: state({
        sources: [copiedSource],
        imageReceipts: [
          {
            ref: copiedSource.ref,
            responseMessageId: copied.info.id,
            logicalRequestId: "inherited-request",
            modelKey: "inherited-model",
            policyHash: HASH,
            representationHash: HASH,
            generation: 2,
          },
        ],
      }),
      observations: [
        observation("child-point", {
          generation: 2,
          historyVersion: "parent-history-2",
          origin: "inherited",
          status: "completed",
          completedAt: 20,
          actualInputTokens: 101,
        }),
      ],
      operations: [
        operation("child-operation", {
          generation: 2,
          historyVersion: "parent-history-2",
          origin: "inherited",
          status: "completed",
          completedAt: 20,
          summary: "合成祖先摘要",
          sources: [
            {
              ref: copiedSource.ref,
              messageId: copied.info.id,
              partId: copied.parts[0]!.id,
              imageIndex: null,
              kind: "text",
              originalAvailable: true,
            },
          ],
        }),
      ],
    },
  };
}

test("fork copies inherited frozen facts into child generation zero and retries return one child", async (t) => {
  const store = await memoryStore(t);
  await store.createSession(sessionInput(PARENT_ID));
  await store.setRevert({
    sessionID: PARENT_ID,
    revert: { messageID: createMessageId("parent-anchor"), branchGeneration: 2 },
  });
  const parentState = state({ generation: 2, historyVersion: "parent-history-2" });
  const parentPoint = observation("parent-point", {
    generation: 2,
    historyVersion: "parent-history-2",
    status: "completed",
    actualInputTokens: 101,
    completedAt: 20,
  });
  await store.commitNativeContext(PARENT_ID, {
    expectedRevision: null,
    expectedGeneration: 2,
    state: parentState,
    observations: [parentPoint],
  });
  const bundle = forkBundle();
  await store.commitForkBundle(bundle);
  await store.commitForkBundle(bundle);
  assert.deepEqual(await store.getNativeContextForkBundle(CHILD_ID), bundle.nativeContext);
  assert.equal((await store.getNativeContextState(CHILD_ID))!.generation, 0);
  const inherited = (await store.listNativeContextObservations(CHILD_ID, {})).items[0]!;
  assert.equal(inherited.generation, 2);
  assert.equal(inherited.historyVersion, "parent-history-2");
  assert.equal(inherited.origin, "inherited");
  assert.equal((await store.messages({ sessionID: CHILD_ID })).length, 1);
  assert.equal(
    (await store.sessionEntries({ sessionID: PARENT_ID, type: "v4/command_fact" })).length,
    1,
  );
  await store.commitNativeContext(CHILD_ID, {
    expectedRevision: 0,
    expectedGeneration: 0,
    state: { ...bundle.nativeContext!.state, revision: 1 },
    observations: [observation("child-own")],
  });
  assert.deepEqual((await store.listNativeContextObservations(PARENT_ID, {})).items, [parentPoint]);
  assert.equal(
    (await store.listNativeContextObservations(CHILD_ID, {})).items.filter(
      (point) => point.origin === "own",
    ).length,
    1,
  );
});

test("fork failure after native rows and later command fact rolls back the entire child", async (t) => {
  const stages: ForkCommitFaultStage[] = ["afterNativeContext", "afterCommandFact", "beforeCommit"];
  for (const stage of stages) {
    await t.test(stage, async (childTest) => {
      const store = await memoryStore(childTest, { forkCommitFaultAt: stage });
      await store.createSession(sessionInput(PARENT_ID));
      await assert.rejects(store.commitForkBundle(forkBundle()), /injected fork commit fault/);
      assert.equal(await store.getSession(CHILD_ID), null);
      assert.equal(await store.getNativeContextState(CHILD_ID), null);
      assert.equal(await store.getNativeContextOperation(CHILD_ID, "child-operation"), null);
      assert.deepEqual(await store.messages({ sessionID: CHILD_ID }), []);
      assert.deepEqual(
        await store.sessionEntries({ sessionID: PARENT_ID, type: "v4/command_fact" }),
        [],
      );
      assert.equal(await store.getSessionInputById("child-input"), null);
    });
  }
});

test("fork rejects parent sources and mismatched child message/part pairs before writes", async (t) => {
  const store = await memoryStore(t);
  await store.createSession(sessionInput(PARENT_ID));
  const parentReference = forkBundle();
  parentReference.nativeContext!.state.sources[0]!.messageId = "parent-message";
  await assert.rejects(store.commitForkBundle(parentReference), conflict("record"));
  const wrongPair = forkBundle();
  const second = message(CHILD_ID, "second");
  wrongPair.messages.push(second);
  wrongPair.nativeContext!.state.sources[0]!.partId = second.parts[0]!.id;
  await assert.rejects(store.commitForkBundle(wrongPair), conflict("record"));
  const wrongReceipt = forkBundle();
  wrongReceipt.nativeContext!.state.imageReceipts[0]!.responseMessageId = "parent-response";
  await assert.rejects(store.commitForkBundle(wrongReceipt), conflict("record"));
  assert.equal(await store.getSession(CHILD_ID), null);
});
