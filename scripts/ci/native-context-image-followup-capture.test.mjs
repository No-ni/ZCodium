import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { loadComponentCallback } from "./fixtures/component-callback.mjs";

const source =
  "packages/desktop/test/e2e/helpers/native-context-compression/image-negative-followup.ts";
const target = { sessionId: "synthetic-capture-session", workspacePath: "synthetic-workspace" };

function expectation(actual) {
  return {
    toBe: (value) => assert.equal(actual, value),
    toEqual: (value) => assert.deepEqual(actual, value),
    toHaveLength: (value) => assert.equal(actual.length, value),
    toBeNull: () => assert.equal(actual, null),
    not: { toBe: (value) => assert.notEqual(actual, value) },
  };
}

async function fixture(
  kind,
  statuses,
  { turnState = "completedSuccess", extraRequest = false } = {},
) {
  const bytes = Buffer.from("synthetic immutable original");
  const originalSha256 = createHash("sha256").update(bytes).digest("hex");
  const contract = { fixtureId: "synthetic-" + kind, marker: "synthetic-" + kind, inputTokens: 18 };
  const model = { providerId: "synthetic-provider", modelId: "synthetic-model" };
  const status = {
    policy: { policyVersion: 1 },
    generation: 0,
    currentSegmentId: "initial",
    effectiveBlocks: 0,
  };
  const oldTool = {
    kind: "toolCall",
    rowId: 2,
    toolCallId: "synthetic-old-tool",
    turnId: "synthetic-old-turn",
    status: "success",
    inputText: "synthetic-ref",
  };
  let submitted = false,
    reads = 0,
    polls = 0,
    cleanups = 0;
  const currentRows = () =>
    submitted
      ? [
          oldTool,
          {
            kind: "userInput",
            rowId: 4,
            turnId: "synthetic-new-turn",
            text: contract.marker + ":",
          },
          { kind: "turnHeader", rowId: 3, turnId: "synthetic-new-turn", state: turnState },
        ]
      : [oldTool];
  class FollowupError extends Error {
    constructor(evidence) {
      super(evidence.availability);
      this.evidence = evidence;
    }
  }
  const run = await loadComponentCallback(source, "assertNativeContextImageFailureFollowup", {
    expect: expectation,
    createHash,
    nativeContextCurrentTarget: async () => target,
    getV4ComposerText: async () => "synthetic draft",
    setV4ComposerText: async (value) => {
      assert.equal(value, "synthetic draft");
      cleanups++;
    },
    withNativeContextCleanup: async (action, cleanup) => {
      try {
        return await action();
      } finally {
        await cleanup();
      }
    },
    waitForV4ConversationState: async (predicate) => {
      assert.equal(predicate({ sessionId: target.sessionId, state: "idle", queueCount: 0 }), true);
    },
    getNativeContextStatus: async () => structuredClone(status),
    listNativeContextObservations: async () => ({
      nextCursor: null,
      items:
        submitted && turnState === "completedSuccess"
          ? [
              {
                id: "synthetic-new-observation",
                purpose: "main",
                status: "completed",
                actualInputTokens: contract.inputTokens,
                model,
                images: { restoredCount: 0, sentCount: 0 },
              },
            ]
          : [],
    }),
    listNativeContextRecords: async () => ({ nextCursor: null, items: [] }),
    rows: async () => currentRows(),
    readNativeContextComposerModel: async () => model,
    NATIVE_CONTEXT_IMAGE_NEGATIVE_RECOVERY: { [kind]: contract },
    getUpstreamRequestRecordCount: async () => 7,
    sendV4Prompt: async (text) => {
      assert.ok(text.startsWith(contract.marker + ":"));
      assert.equal(submitted, false, "capture waiting must not resubmit the prompt");
      submitted = true;
    },
    browser: {
      waitUntil: async (predicate, options) => {
        for (let index = 0; index < 8; index++) {
          polls++;
          if (await predicate()) return;
        }
        throw new Error(options.timeoutMsg);
      },
    },
    getUpstreamRequestEvidence: async (query, options) => {
      assert.deepEqual(
        query,
        {},
        "unexpected requests must not be filtered by the expected fixture",
      );
      assert.equal(options.afterIndex, 6);
      const captureStatus = statuses[Math.min(reads++, statuses.length - 1)];
      if (captureStatus === "absent") return [];
      const record = {
        fixtureId: contract.fixtureId,
        status: captureStatus,
        statusCode: 200,
        requestJson: { model: model.modelId },
      };
      return extraRequest && captureStatus !== "pending"
        ? [record, { ...record, fixtureId: "synthetic-unexpected-retry" }]
        : [record];
    },
    readNativeContextRecord: async () => ({
      status: "completed",
      observationIds: [],
      sources: [{ ref: "synthetic-ref", originalAvailable: true }],
    }),
    readNativeContextOriginalImage: async () => ({ bytes: Uint8Array.from(bytes) }),
    TID_CHAT_ERROR_BANNER: "synthetic-error",
    $: () => ({ isDisplayed: async () => false }),
    NativeContextImageFollowupError: FollowupError,
    nativeContextWireImages: () => [],
  });
  const negative = {
    kind,
    target,
    toolRowId: oldTool.rowId,
    toolCallId: oldTool.toolCallId,
    operationId: "synthetic-restore-operation",
    originalRef: "synthetic-ref",
    originalBytes: bytes.length,
    originalSha256,
  };
  return {
    run: () => run(negative),
    reads: () => reads,
    polls: () => polls,
    cleanups: () => cleanups,
    submitted: () => submitted,
  };
}

for (const kind of ["unsupported", "capacity"]) {
  test(
    kind + " successful new turn waits for its same capture to finish durable publication",
    async () => {
      const f = await fixture(kind, ["pending", "pending", "complete"]);
      const evidence = await f.run();
      assert.equal(evidence.availability, "usable");
      assert.equal(evidence.oldToolPartRetained, true);
      assert.equal(evidence.originalUnchanged, true);
      assert.deepEqual(evidence.providerFixtureIds, ["synthetic-" + kind]);
      assert.equal(f.reads(), 3);
      assert.equal(f.cleanups(), 1);
    },
  );
}

test("a terminal capture error still fails a successful product turn", async () => {
  const f = await fixture("capacity", ["pending", "error"]);
  await assert.rejects(f.run(), /complete/u);
  assert.equal(f.cleanups(), 1);
});

test("an unexpected retry remains in the complete capture and fails the unique-request assertion", async () => {
  const f = await fixture("capacity", ["pending", "complete"], { extraRequest: true });
  await assert.rejects(f.run(), /synthetic-unexpected-retry/u);
  assert.equal(f.cleanups(), 1);
});

test("a capture that stays pending times out without another prompt or a fabricated success", async () => {
  const f = await fixture("capacity", ["pending"]);
  await assert.rejects(f.run(), /capture.*terminal|capture.*settle/u);
  assert.ok(f.polls() > 1);
  assert.equal(f.submitted(), true);
  assert.equal(f.cleanups(), 1);
});

test("a genuinely failed new turn without a provider request reports poisoning immediately", async () => {
  const f = await fixture("capacity", ["absent"], { turnState: "completedError" });
  await assert.rejects(f.run(), (error) => error.evidence?.availability === "poisoned");
  assert.equal(f.reads(), 1);
  assert.equal(f.cleanups(), 1);
});
