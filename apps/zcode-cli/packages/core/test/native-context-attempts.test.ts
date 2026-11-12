import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  createModelId,
  createModelProviderId,
  createSessionEvent,
  ModelTransportKind,
  SessionEventType,
  type Model,
  type ModelInputMessage,
  type ModelNetworkStatusEvent,
  type ModelUsageRecord,
  type TraceContext,
} from "@zcode/contracts";
import type {
  NativeContextObservation,
  NativeContextOperation,
  NativeContextStoredState,
} from "@zcode/shared/native-context-compression";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import type { NativeContextAttemptTrackerInput } from "../src/runtime/native-context-compression/contract.js";
import { createNativeAttemptTracker } from "../src/runtime/native-context-compression/attempts.js";
import { nativeOwner, writeNativeState } from "../src/runtime/native-context-compression/state.js";
import { nativeOperation } from "../src/runtime/native-context-compression/records.js";
import {
  providerModelUsageIdentity,
  recordModelUsageFact,
} from "../src/runtime/model-usage-observability/index.js";
import { commit, fixture, HASH, PARENT } from "./native-context-boundary-fixture.js";

const TRACE = { traceId: "fixture-trace", spanId: "fixture-span" } as TraceContext;
function model(): Model {
  return {
    providerId: createModelProviderId("fixture-provider"),
    modelId: createModelId("fixture-model"),
    options: { reasoningLevel: "medium" },
    properties: { contextWindow: 4096 },
  } as Model;
}
function network(
  type:
    | "model_request_started"
    | "model_request_completed"
    | "model_request_failed"
    | "model_retry_scheduled"
    | "model_request_queued",
  requestId: string,
  attempt: number,
  time: number,
  fields: Record<string, unknown> = {},
): ModelNetworkStatusEvent {
  const base = {
    requestId,
    attempt,
    maxAttempts: 3,
    timestamp: new Date(time).toISOString(),
    traceId: TRACE.traceId,
    spanId: TRACE.spanId,
    providerId: createModelProviderId("fixture-provider"),
    modelId: createModelId("fixture-model"),
    transport: ModelTransportKind.Sse,
  };
  if (type === "model_request_completed") return { ...base, type, durationMs: 100, ...fields };
  if (type === "model_request_failed")
    return {
      ...base,
      type,
      reason: "unknown",
      retryable: false,
      message: "synthetic failure",
      ...fields,
    };
  if (type === "model_retry_scheduled")
    return {
      ...base,
      type,
      delayMs: 20,
      nextAttempt: attempt + 1,
      reason: "network_error",
      message: "synthetic retry",
      ...fields,
    };
  return { ...base, type, ...fields };
}
async function attemptFixture(
  t: TestContext,
  extra: Partial<NativeContextAttemptTrackerInput> = {},
  seed?: (state: NativeContextStoredState) => NativeContextOperation[],
) {
  const base = await fixture(t);
  const operations = seed?.(base.state) ?? [];
  await commit(base.host, base.state, { operations, observations: [] });
  const owner = nativeOwner(base.host);
  owner.state = structuredClone(base.state);
  const before: ModelInputMessage[] = [{ role: "user", content: "合成原始上下文 ".repeat(20) }];
  const after: ModelInputMessage[] = [{ role: "user", content: "合成摘要" }];
  const policy = structuredClone(base.state.policy);
  const input: NativeContextAttemptTrackerInput = {
    comparison: {
      baselineMessages: before,
      baselineEntries: base.host.messageHistory.borrowReadOnlyRuntimeEntries(),
      generation: base.state.generation,
      historyVersion: base.state.historyVersion,
      policyVersion: policy.policyVersion,
      policy: structuredClone(policy),
      segmentId: base.state.compactBoundaryId,
      operationIds: [],
    },
    model: model(),
    beforeMessages: before,
    afterMessages: after,
    tools: [],
    maxOutputTokens: 1024,
    traceContext: TRACE,
    policy,
    sentImages: [],
    anchorMessageId: base.messages[1]!.info.id,
    imageChanges: { omittedRefs: [], foldedRefs: [], resizedRefs: [], restoredRefs: [] },
    ...extra,
  };
  return {
    ...base,
    owner,
    input,
    tracker: createNativeAttemptTracker(base.host, input),
    operations,
  };
}
async function points(
  f: Awaited<ReturnType<typeof attemptFixture>>,
  purpose?: NativeContextObservation["purpose"],
) {
  const page = await f.store.listNativeContextObservations(PARENT, {
    limit: 200,
    ...(purpose ? { purpose } : {}),
  });
  return [...page.items].reverse();
}
async function deliver(
  f: Awaited<ReturnType<typeof attemptFixture>>,
  events: ModelNetworkStatusEvent[],
) {
  for (const event of events) await f.tracker.onStatus(event);
}

test("native attempts and model ledger share physical retry identities and preserve charged failed usage", async (t) => {
  const f = await attemptFixture(t);
  const events = [
    network("model_request_started", "physical", 1, 100),
    network("model_request_failed", "physical", 1, 200, {
      reason: "network_error",
      retryable: true,
      message: "synthetic failure",
      usage: { inputTokens: 30, outputTokens: 0, cacheReadTokens: 0 },
    }),
    network("model_retry_scheduled", "physical", 1, 220, { nextAttempt: 2, delayMs: 20 }),
    network("model_request_started", "physical", 2, 250),
    network("model_request_completed", "physical", 2, 350, {
      usage: { inputTokens: 50, outputTokens: 5, cacheReadTokens: 12 },
    }),
  ];
  await deliver(f, events);
  await f.tracker.finish({ status: "completed", usage: { inputTokens: 50, outputTokens: 5 } });
  const facts: ModelUsageRecord[] = [];
  const ledgerHost = {
    ...f.host,
    sessionStore: {
      recordModelUsage: async (fact: ModelUsageRecord) => {
        facts.push(fact);
      },
      upsertTurnUsage: async () => {},
      upsertToolUsage: async () => {},
      pruneUsage: async () => {},
    },
  } as unknown as AgentRuntimeInternal;
  await recordModelUsageFact(ledgerHost, {
    events: events.map((event) =>
      createSessionEvent(SessionEventType.ModelNetworkStatus, PARENT, event),
    ),
    model: f.input.model,
    networkEventStartIndex: 0,
    querySource: "main_turn",
    startedAt: 100,
    status: "completed",
    traceContext: TRACE,
    result: { text: "合成响应", finishReason: "stop", usage: { inputTokens: 50, outputTokens: 5 } },
  });
  const rows = await points(f, "main");
  assert.deepEqual(
    rows.map((row) => row.usageRecordRef),
    facts.map((fact) => fact.id),
  );
  assert.deepEqual(
    rows.map((row) => [row.attemptIndex, row.requestSeq, row.status, row.actualInputTokens]),
    [
      [0, 1, "error", 30],
      [1, 2, "completed", 50],
    ],
  );
  assert.equal(rows[0]?.cacheReadTokens, 0);
  assert.equal(rows[1]?.cacheReadTokens, 12);
  assert.equal(rows[1]?.actualInputTokens, 50);
  assert.equal(
    rows.reduce((sum, row) => sum + (row.actualInputTokens ?? 0), 0),
    80,
  );
  assert.equal(f.owner.state!.requestSeq, 2);
});

test("stream to HTTP fallback and duplicate statuses retain exactly two native points", async (t) => {
  const f = await attemptFixture(t);
  const failed = network("model_request_failed", "stream", 1, 200, {
    reason: "unknown",
    retryable: false,
    message: "synthetic failure",
    usage: { inputTokens: 8 },
  });
  const completed = network("model_request_completed", "http", 1, 350, {
    transport: ModelTransportKind.Http,
    usage: { inputTokens: 20, outputTokens: 4 },
  });
  await deliver(f, [
    network("model_request_started", "stream", 1, 100),
    failed,
    failed,
    network("model_request_started", "http", 1, 250),
    completed,
    completed,
  ]);
  await f.tracker.finish({ status: "completed", usage: { inputTokens: 20, outputTokens: 4 } });
  const revision = f.owner.state!.revision;
  await f.tracker.finish({ status: "completed", usage: { inputTokens: 20, outputTokens: 4 } });
  assert.equal(f.owner.state!.revision, revision);
  assert.deepEqual(
    (await points(f)).map((row) => row.id),
    ["usage_model_main_turn_stream_0", "usage_model_main_turn_http_0"],
  );
  assert.equal(f.owner.state!.requestSeq, 2);
});

test("unknown failed usage stays null and a final result supplements only the matching success with real zero", async (t) => {
  const f = await attemptFixture(t);
  await deliver(f, [
    network("model_request_started", "request", 1, 100),
    network("model_request_failed", "request", 1, 200, {
      reason: "unknown",
      retryable: true,
      message: "synthetic failure",
    }),
    network("model_request_started", "request", 2, 250),
    network("model_request_completed", "request", 2, 350),
  ]);
  assert.equal((await points(f))[1]?.status, "prepared");
  await f.tracker.finish({
    status: "completed",
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });
  const rows = await points(f);
  assert.equal(rows[0]?.actualInputTokens, null);
  assert.equal(rows[0]?.outputTokens, null);
  assert.equal(rows[1]?.actualInputTokens, 0);
  assert.equal(rows[1]?.outputTokens, 0);
  assert.equal(rows[1]?.cacheReadTokens, 0);
  assert.equal(rows[1]?.cacheCreateTokens, 0);
  assert.equal(rows[1]?.completedAt, 350);
});

test("missing network identity and orphan terminal events cannot invent a main point or successful image receipt", async (t) => {
  const f = await attemptFixture(t, {
    sentImages: [
      {
        ref: "m_0",
        responseMessageId: "msg_fixture-response",
        logicalRequestId: "proposal",
        modelKey: "fixture-provider/fixture-model",
        policyHash: HASH,
        representationHash: HASH,
        generation: 0,
      },
    ],
  });
  await deliver(f, [
    network("model_request_queued", "queued", 1, 100),
    network("model_retry_scheduled", "queued", 1, 150, { nextAttempt: 2, delayMs: 20 }),
    network("model_request_completed", "orphan", 1, 200, { usage: { inputTokens: 10 } }),
  ]);
  await f.tracker.finish({ status: "completed", usage: { inputTokens: 10 } });
  assert.equal((await points(f)).length, 0);
  assert.equal(f.owner.state!.requestSeq, 0);
  assert.equal(f.tracker.successfulReceipts.length, 0);
  assert.equal(f.input.sentImages[0]?.logicalRequestId, "proposal");
});

test("policy, model budget, history and estimates remain frozen across later policy and model mutations", async (t) => {
  const f = await attemptFixture(t);
  f.input.policy.parameters.trigger.start = { kind: "tokens", value: 100 };
  f.input.policy.parameters.trigger.target = { kind: "tokens", value: 50 };
  const tracker = createNativeAttemptTracker(f.host, f.input);
  f.input.policy.parameters.trigger.start = { kind: "tokens", value: 999 };
  f.input.model.properties.contextWindow = 8192;
  f.input.beforeMessages[0]!.content = "mutation after request freeze".repeat(200);
  await tracker.onStatus(network("model_request_started", "frozen", 1, 100));
  const prepared = (await points(f))[0]!;
  await writeNativeState(f.owner, (candidate) => {
    candidate.policy.policyVersion += 1;
    candidate.policy.parameters.trigger.start = { kind: "tokens", value: 1000 };
    candidate.historyVersion = "later-history-version";
  });
  await tracker.onStatus(
    network("model_request_completed", "frozen", 1, 350, { usage: { inputTokens: 0 } }),
  );
  await tracker.finish({ status: "completed", usage: { inputTokens: 999 } });
  const completed = (await points(f))[0]!;
  assert.equal(completed.inputBudget, 3072);
  assert.equal(completed.contextWindow, 4096);
  assert.equal(completed.startTokens, 100);
  assert.equal(completed.targetTokens, 50);
  assert.equal(completed.policyVersion, 3);
  assert.equal(completed.historyVersion, f.state.historyVersion);
  assert.equal(completed.beforeEstimate, prepared.beforeEstimate);
  assert.equal(completed.afterEstimate, prepared.afterEstimate);
  assert.equal(completed.actualInputTokens, 0);
  assert.equal(completed.outputTokens, null);
});

test("image decoded bytes stay separate from full token estimates, cache and unknown vision tokens", async (t) => {
  const f = await attemptFixture(t, {
    beforeMessages: [
      {
        role: "user",
        content: [
          { type: "text", text: "x" },
          { type: "image", mediaType: "image/png", dataUrl: "data:image/png;base64,AQIDBAUGBwgJ" },
        ],
      },
    ],
    afterMessages: [
      {
        role: "user",
        content: [
          { type: "text", text: "visibility marker and restored context".repeat(20) },
          { type: "image", mediaType: "image/png", dataUrl: "data:image/png;base64,AQID" },
        ],
      },
    ],
    imageChanges: {
      omittedRefs: [],
      foldedRefs: [],
      resizedRefs: ["m_0", "m_0"],
      restoredRefs: [],
    },
  });
  await deliver(f, [
    network("model_request_started", "image", 1, 100),
    network("model_request_completed", "image", 1, 200, {
      usage: { inputTokens: 100, outputTokens: 0, cacheReadTokens: 30 },
    }),
  ]);
  await f.tracker.finish({ status: "completed" });
  const row = (await points(f))[0]!;
  assert.equal(row.measurementScope, "text-only");
  assert.equal(row.beforeEstimate, null);
  assert.equal(row.afterEstimate, null);
  assert.ok(row.textAfterEstimate! > row.textBeforeEstimate!);
  assert.deepEqual(row.images, {
    sourceCount: 1,
    sourceCoverage: 1,
    sentCount: 1,
    beforeBytes: 9,
    afterBytes: 3,
    omittedCount: 0,
    foldedCount: 0,
    resizedCount: 1,
    restoredCount: 0,
  });
  assert.equal(row.actualInputTokens, 100);
  assert.equal(row.cacheReadTokens, 30);
  assert.equal(row.visionTokens, null);
});

test("an unsendable original-image baseline stays unknown while the actual text request remains independently measurable", async (t) => {
  const f = await attemptFixture(t, {
    baselineMeasurable: false,
    beforeMessages: [
      {
        role: "user",
        content: [
          { type: "text", text: "synthetic baseline text" },
          { type: "image", mediaType: "image/png", dataUrl: "data:image/png;base64,AQID" },
        ],
      },
    ],
    afterMessages: [{ role: "user", content: "synthetic image visibility marker" }],
    imageChanges: { omittedRefs: ["m_0"], foldedRefs: [], resizedRefs: [], restoredRefs: [] },
  });
  await deliver(f, [
    network("model_request_started", "oversize-baseline", 1, 100),
    network("model_request_completed", "oversize-baseline", 1, 200, { usage: { inputTokens: 0 } }),
  ]);
  await f.tracker.finish({ status: "completed" });
  const row = (await points(f))[0]!;
  assert.equal(row.measurementScope, "text-only");
  assert.equal(row.beforeEstimate, null);
  assert.equal(row.images.beforeBytes, null);
  assert.equal(row.images.sourceCount, 1);
  assert.equal(row.images.sentCount, 0);
  assert.equal(row.images.afterBytes, 0);
  assert.ok(row.textBeforeEstimate! > 0);
  assert.equal(row.afterEstimate, row.textAfterEstimate);
  assert.ok(row.afterEstimate! > 0);
  assert.equal(row.actualInputTokens, 0);
});

test("successful receipts keep the original WeakMap array and use the last actual successful request", async (t) => {
  const sentImages = [
    {
      ref: "m_0",
      responseMessageId: "msg_fixture-response",
      logicalRequestId: "proposal",
      modelKey: "fixture-provider/fixture-model",
      policyHash: HASH,
      representationHash: HASH,
      generation: 0,
    },
  ];
  const f = await attemptFixture(t, { sentImages });
  await deliver(f, [
    network("model_request_started", "stream", 1, 100),
    network("model_request_failed", "stream", 1, 200, {
      reason: "unknown",
      retryable: false,
      message: "synthetic failure",
    }),
    network("model_request_started", "actual-http", 1, 250),
    network("model_request_completed", "actual-http", 1, 350, { usage: { inputTokens: 0 } }),
  ]);
  assert.equal(f.tracker.successfulReceipts.length, 0);
  await f.tracker.finish({ status: "completed" });
  assert.strictEqual(f.tracker.successfulReceipts, sentImages);
  assert.equal(sentImages[0]?.logicalRequestId, "actual-http");
  assert.equal(f.owner.state!.imageReceipts.length, 0);
});

test("a successful network terminal followed by call-tail failure preserves usage and rejects image receipts", async (t) => {
  const f = await attemptFixture(t, {
    sentImages: [
      {
        ref: "m_0",
        responseMessageId: "msg_fixture-response",
        logicalRequestId: "proposal",
        modelKey: "fixture-provider/fixture-model",
        policyHash: HASH,
        representationHash: HASH,
        generation: 0,
      },
    ],
  });
  await deliver(f, [
    network("model_request_started", "tail-error", 1, 100),
    network("model_request_completed", "tail-error", 1, 200, { usage: { inputTokens: 10 } }),
  ]);
  await f.tracker.finish({ status: "error", error: new Error("synthetic postprocessing failure") });
  const row = (await points(f))[0]!;
  assert.equal(row.status, "completed");
  assert.equal(row.actualInputTokens, 10);
  assert.equal(f.tracker.successfulReceipts.length, 0);
  assert.equal(f.input.sentImages[0]?.logicalRequestId, "proposal");
  await f.tracker.finish({ status: "completed" });
  assert.equal(f.tracker.successfulReceipts.length, 0);
});

test("maintenance and decision attempts link their operation without advancing or replacing the main trend", async (t) => {
  for (const purpose of ["maintenance", "decision"] as const)
    await t.test(purpose, async (subtest) => {
      let operationId = "";
      const f = await attemptFixture(subtest, {}, (state) => {
        const operation = nativeOperation(state, {
          kind: purpose === "decision" ? "decision" : "summary",
          trigger: "manual",
        });
        operationId = operation.operationId;
        return [operation];
      });
      f.owner.inputBudget = 2048;
      const tracker = createNativeAttemptTracker(f.host, {
        ...f.input,
        purpose,
        operationId,
        querySource: purpose === "decision" ? "native_context_decision" : "native_context_summary",
      });
      await tracker.onStatus(network("model_request_started", "maintenance", 1, 100));
      await tracker.onStatus(
        network("model_request_failed", "maintenance", 1, 200, {
          reason: "unknown",
          retryable: true,
          message: "synthetic failure",
          usage: { inputTokens: 30, outputTokens: 0 },
        }),
      );
      await tracker.onStatus(network("model_request_started", "maintenance", 2, 250));
      await tracker.onStatus(
        network("model_request_completed", "maintenance", 2, 350, {
          usage: { inputTokens: 40, outputTokens: 5 },
        }),
      );
      await tracker.finish({ status: "completed" });
      assert.equal((await points(f, "main")).length, 0);
      const rows = await points(f, purpose);
      assert.equal(rows.length, 2);
      assert.ok(
        rows.every((row) => row.requestSeq === 0 && row.operationIds.includes(operationId)),
      );
      assert.equal(f.owner.state!.requestSeq, 0);
      assert.equal(f.owner.lastObservation, null);
      assert.equal(f.owner.inputBudget, 2048);
      const operation = await f.store.getNativeContextOperation(PARENT, operationId);
      assert.deepEqual(operation?.observationIds, tracker.observationIds);
      const filtered = await f.store.listNativeContextObservations(PARENT, {
        limit: 200,
        purpose,
        operationId,
      });
      assert.equal(filtered.items.length, 2);
    });
});

test("a terminal write failure retries the same row at finish and keeps private storage errors out of logs", async (t) => {
  const f = await attemptFixture(t);
  const original = f.store.commitNativeContext.bind(f.store);
  let fail = true;
  f.store.commitNativeContext = async (sessionId, input) => {
    if (fail && input.observations?.some((row) => row.status === "completed")) {
      fail = false;
      throw new Error("synthetic private database details");
    }
    return original(sessionId, input);
  };
  const warnings: unknown[] = [];
  f.host.logger = {
    warn: (_message: string, context: unknown) => {
      warnings.push(context);
    },
  } as AgentRuntimeInternal["logger"];
  await deliver(f, [
    network("model_request_started", "storage-retry", 1, 100),
    network("model_request_completed", "storage-retry", 1, 200, { usage: { inputTokens: 80 } }),
  ]);
  assert.equal((await points(f))[0]?.status, "prepared");
  await f.tracker.finish({ status: "completed" });
  const rows = await points(f);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.status, "completed");
  assert.equal(rows[0]?.actualInputTokens, 80);
  assert.equal(f.owner.state!.requestSeq, 1);
  assert.equal(warnings.length, 1);
  assert.equal(JSON.stringify(warnings).includes("synthetic private database details"), false);
});

test("branch change after preparation cannot resurrect a future point or an image receipt", async (t) => {
  const f = await attemptFixture(t, {
    sentImages: [
      {
        ref: "m_0",
        responseMessageId: "msg_fixture-response",
        logicalRequestId: "proposal",
        modelKey: "fixture-provider/fixture-model",
        policyHash: HASH,
        representationHash: HASH,
        generation: 0,
      },
    ],
  });
  await f.tracker.onStatus(network("model_request_started", "old-branch", 1, 100));
  const revision = f.owner.state!.revision;
  f.host.branchGeneration = 1;
  await f.tracker.onStatus(
    network("model_request_completed", "old-branch", 1, 200, { usage: { inputTokens: 10 } }),
  );
  await f.tracker.finish({ status: "completed" });
  assert.equal(f.owner.state!.revision, revision);
  assert.equal(f.tracker.successfulReceipts.length, 0);
});

test("the identity helper still matches a main subagent call when its actual query source is supplied", async (t) => {
  const f = await attemptFixture(t, { querySource: "subagent" });
  await deliver(f, [
    network("model_request_started", "child", 1, 100),
    network("model_request_completed", "child", 1, 200, { usage: { inputTokens: 0 } }),
  ]);
  await f.tracker.finish({ status: "completed" });
  assert.equal(
    (await points(f))[0]?.usageRecordRef,
    providerModelUsageIdentity("subagent", { requestId: "child", attempt: 1 }).id,
  );
});
