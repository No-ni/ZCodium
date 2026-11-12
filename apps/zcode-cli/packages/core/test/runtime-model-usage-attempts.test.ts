import assert from "node:assert/strict";
import test from "node:test";
import {
  createMessageId,
  createSessionEvent,
  createSessionId,
  SessionEventType,
  type Model,
  type ModelUsage,
  type ModelUsageRecord,
  type SessionEvent,
  type TraceContext,
} from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import type { RuntimeModelTextResult } from "../src/runtime/types.js";
import {
  providerModelUsageIdentity,
  recordModelUsageFact,
} from "../src/runtime/methods/usage-observability.js";

const SESSION = createSessionId("usage-attempt-fixture");
const ASSISTANT = createMessageId("msg_usage-response");
const TRACE = { traceId: "fixture-trace", spanId: "fixture-span" } as TraceContext;
const model = {
  providerId: "fixture-provider",
  modelId: "fixture-model",
  options: { reasoningLevel: "medium" },
} as Model;
type UsageInput = Parameters<typeof recordModelUsageFact>[1];

function result(usage: ModelUsage): RuntimeModelTextResult {
  return {
    text: "合成响应",
    reasoning: [],
    toolCalls: [],
    finishReason: "stop",
    usage,
    providerMetadata: { fixture: "final-response" },
  };
}

function network(
  type:
    | "model_request_started"
    | "model_request_completed"
    | "model_request_failed"
    | "model_retry_scheduled",
  requestId: string,
  attempt: number,
  time: number,
  fields: Record<string, unknown> = {},
): SessionEvent {
  return {
    ...createSessionEvent(SessionEventType.ModelNetworkStatus, SESSION, {
      type,
      requestId,
      attempt,
      maxAttempts: 3,
      timestamp: new Date(time).toISOString(),
      providerId: "fixture-provider",
      modelId: "fixture-model",
      transport: "stream",
      traceId: TRACE.traceId,
      spanId: TRACE.spanId,
      ...fields,
    }),
    timestamp: new Date(time),
  };
}
function input(events: SessionEvent[], extra: Partial<UsageInput> = {}): UsageInput {
  return {
    assistantMessageId: ASSISTANT,
    events,
    model,
    networkEventStartIndex: 0,
    querySource: "main_turn",
    startedAt: 100,
    status: "completed",
    traceContext: TRACE,
    ...extra,
  };
}
function fixture(onWrite?: (fact: ModelUsageRecord) => void) {
  const writes: ModelUsageRecord[] = [];
  const stored = new Map<string, ModelUsageRecord>();
  const warnings: Record<string, unknown>[] = [];
  const runtime = {
    sessionId: SESSION,
    config: { agentName: "fixture", mode: "build", taskType: "interactive" },
    logger: {
      warn: (_message: string, context: Record<string, unknown>) => {
        warnings.push(context);
      },
    },
    sessionStore: {
      recordModelUsage: async (fact: ModelUsageRecord) => {
        onWrite?.(fact);
        writes.push(fact);
        stored.set(fact.id, fact);
      },
      upsertTurnUsage: async () => {},
      upsertToolUsage: async () => {},
      pruneUsage: async () => {},
    },
  } as unknown as AgentRuntimeInternal;
  return { runtime, writes, stored, warnings };
}

test("provider usage and native observation identity share real request ID and a zero-based attempt", () => {
  assert.deepEqual(
    providerModelUsageIdentity("main_turn", { requestId: "physical-request", attempt: 2 }),
    {
      id: "usage_model_main_turn_physical-request_1",
      logicalRequestId: "physical-request",
      attemptIndex: 1,
    },
  );
  assert.throws(
    () => providerModelUsageIdentity("main_turn", { requestId: "", attempt: 1 }),
    /MODEL_USAGE_ATTEMPT_IDENTITY_INVALID/u,
  );
  assert.throws(
    () => providerModelUsageIdentity("main_turn", { requestId: "physical-request", attempt: 0 }),
    /MODEL_USAGE_ATTEMPT_IDENTITY_INVALID/u,
  );
});

test("a charged failed retry and the successful retry produce two exact facts without an aggregate charge", async () => {
  const f = fixture();
  const failedUsage = { inputTokens: 30, outputTokens: 0, cacheReadTokens: 0, totalTokens: 30 };
  const successUsage = { inputTokens: 50, outputTokens: 5, cacheReadTokens: 12, totalTokens: 55 };
  const events = [
    network("model_request_started", "request", 1, 100),
    network("model_request_failed", "request", 1, 200, {
      reason: "network_error",
      retryable: true,
      message: "fixture failure",
      usage: failedUsage,
      durationMs: 100,
    }),
    network("model_retry_scheduled", "request", 1, 220, { nextAttempt: 2, delayMs: 20 }),
    network("model_request_started", "request", 2, 250),
    network("model_request_completed", "request", 2, 350, {
      usage: successUsage,
      durationMs: 100,
      timeToFirstContentMs: 0,
    }),
  ];
  await recordModelUsageFact(
    f.runtime,
    input(events, { result: result(successUsage), toolCallCount: 2 }),
  );
  assert.deepEqual(
    f.writes.map((fact) => [fact.id, fact.status, fact.inputTokens, fact.outputTokens]),
    [
      ["usage_model_main_turn_request_0", "error", 30, 0],
      ["usage_model_main_turn_request_1", "completed", 50, 5],
    ],
  );
  assert.equal(
    f.writes.reduce((sum, fact) => sum + (fact.inputTokens ?? 0), 0),
    80,
  );
  assert.equal(f.writes[0]?.retryCount, 1);
  assert.equal(f.writes[1]?.retryCount, 0);
  assert.equal(f.writes[0]?.cacheReadInputTokens, 0);
  assert.equal(f.writes[1]?.firstTokenAt, 250);
  assert.equal(f.writes[1]?.toolCallCount, 2);
  assert.ok(f.writes.every((fact) => fact.assistantMessageID === ASSISTANT));
});

test("stream to HTTP fallback has distinct physical IDs and duplicate status delivery is charged once", async () => {
  const f = fixture();
  const failed = network("model_request_failed", "stream", 1, 200, {
    reason: "unknown",
    retryable: false,
    message: "fixture failure",
    usage: { inputTokens: 8 },
  });
  const completed = network("model_request_completed", "http", 1, 350, {
    usage: { inputTokens: 20, outputTokens: 4 },
    transport: "generate",
  });
  const events = [
    network("model_request_started", "stream", 1, 100),
    failed,
    failed,
    network("model_request_started", "http", 1, 250),
    completed,
    completed,
  ];
  await recordModelUsageFact(
    f.runtime,
    input(events, { result: result({ inputTokens: 20, outputTokens: 4 }) }),
  );
  assert.deepEqual(
    f.writes.map((fact) => fact.id),
    ["usage_model_main_turn_stream_0", "usage_model_main_turn_http_0"],
  );
  assert.equal(f.stored.size, 2);
  assert.equal(f.writes[0]?.status, "error");
  assert.equal(f.writes[1]?.status, "completed");
});

test("unknown retry usage remains unknown while the final successful result preserves real zero", async () => {
  const f = fixture();
  const events = [
    network("model_request_started", "request", 1, 100),
    network("model_request_failed", "request", 1, 200, {
      reason: "unknown",
      retryable: true,
      message: "fixture failure",
    }),
    network("model_request_started", "request", 2, 250),
    network("model_request_completed", "request", 2, 350),
  ];
  await recordModelUsageFact(
    f.runtime,
    input(events, {
      result: result({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
      }),
    }),
  );
  assert.equal(f.writes[0]?.inputTokens, undefined);
  assert.equal(f.writes[0]?.outputTokens, undefined);
  assert.equal(f.writes[0]?.rawUsage, undefined);
  assert.equal(f.writes[1]?.inputTokens, 0);
  assert.equal(f.writes[1]?.outputTokens, 0);
  assert.equal(f.writes[1]?.cacheReadInputTokens, 0);
  assert.equal(f.writes[1]?.cacheCreationInputTokens, 0);
});

test("multiple compact calls in the same span keep separate real network identities", async () => {
  const f = fixture();
  for (const requestId of ["compact-a", "compact-b"]) {
    const events = [
      network("model_request_started", requestId, 1, 100),
      network("model_request_completed", requestId, 1, 200, { usage: { inputTokens: 5 } }),
    ];
    await recordModelUsageFact(
      f.runtime,
      input(events, {
        assistantMessageId: undefined,
        querySource: "compact",
        attemptIndex: 0,
        result: result({ inputTokens: 5 }),
      }),
    );
  }
  assert.deepEqual(
    f.writes.map((fact) => fact.id),
    ["usage_model_compact_compact-a_0", "usage_model_compact_compact-b_0"],
  );
  assert.equal(f.stored.size, 2);
});

test("cancellation during retry backoff preserves the prior attempt failure and charges no imaginary next attempt", async () => {
  const f = fixture();
  const events = [
    network("model_request_started", "request", 1, 100),
    network("model_request_failed", "request", 1, 200, {
      reason: "network_error",
      retryable: true,
      message: "fixture failure",
      usage: { inputTokens: 7 },
    }),
    network("model_retry_scheduled", "request", 1, 220, { nextAttempt: 2, delayMs: 20 }),
  ];
  await recordModelUsageFact(
    f.runtime,
    input(events, { status: "cancelled", error: new Error("synthetic cancelled") }),
  );
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0]?.status, "error");
  assert.equal(f.writes[0]?.cancelledByUser, false);
  assert.equal(f.writes[0]?.inputTokens, 7);
});

test("a failed fact write does not lose subsequent attempt usage or log the raw storage error", async () => {
  const f = fixture((fact) => {
    if (fact.attemptIndex === 0) throw new Error("synthetic private storage details");
  });
  const events = [
    network("model_request_started", "request", 1, 100),
    network("model_request_failed", "request", 1, 200, {
      reason: "unknown",
      retryable: true,
      message: "fixture failure",
      usage: { inputTokens: 7 },
    }),
    network("model_request_started", "request", 2, 250),
    network("model_request_completed", "request", 2, 350, { usage: { inputTokens: 9 } }),
  ];
  await recordModelUsageFact(f.runtime, input(events, { result: result({ inputTokens: 9 }) }));
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0]?.attemptIndex, 1);
  assert.equal(f.writes[0]?.inputTokens, 9);
  assert.equal(f.warnings.length, 1);
  assert.equal(JSON.stringify(f.warnings).includes("synthetic private storage details"), false);
});

test("a model without network identity retains the existing logical-call fact ID and usage", async () => {
  const f = fixture();
  await recordModelUsageFact(
    f.runtime,
    input([], { result: result({ inputTokens: 0, outputTokens: 0 }) }),
  );
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0]?.id, `usage_model_main_turn_${ASSISTANT}_0`);
  assert.equal(f.writes[0]?.logicalRequestId, ASSISTANT);
  assert.equal(f.writes[0]?.inputTokens, 0);
  assert.equal(f.writes[0]?.outputTokens, 0);
});

test("a started attempt interrupted before its terminal keeps the actual stream window and elapsed call time", async (t) => {
  t.mock.method(Date, "now", () => 500);
  const f = fixture();
  const streaming = {
    ...createSessionEvent(SessionEventType.ModelStreaming, SESSION, {
      kind: "text_delta",
      delta: "合成增量",
    }),
    timestamp: new Date(175),
  };
  await recordModelUsageFact(
    f.runtime,
    input([network("model_request_started", "interrupted", 1, 100), streaming], {
      status: "cancelled",
      error: new Error("synthetic cancellation"),
    }),
  );
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0]?.status, "cancelled");
  assert.equal(f.writes[0]?.completedAt, 500);
  assert.equal(f.writes[0]?.durationMs, 400);
  assert.equal(f.writes[0]?.firstTokenAt, 175);
  assert.equal(f.writes[0]?.timeToFirstTokenMs, 75);
  assert.equal(f.writes[0]?.inputTokens, undefined);
});

test("terminal model and real zero usage are frozen even if the logical result carries different values", async () => {
  const f = fixture();
  await recordModelUsageFact(
    f.runtime,
    input(
      [
        network("model_request_started", "frozen", 1, 100, {
          providerId: "actual-provider",
          modelId: "actual-model",
        }),
        network("model_request_completed", "frozen", 1, 350, {
          providerId: "actual-provider",
          modelId: "actual-model",
          usage: { inputTokens: 0, outputTokens: 0 },
          durationMs: 0,
        }),
      ],
      { result: result({ inputTokens: 999, outputTokens: 999 }) },
    ),
  );
  assert.equal(f.writes[0]?.providerId, "actual-provider");
  assert.equal(f.writes[0]?.modelId, "actual-model");
  assert.equal(f.writes[0]?.inputTokens, 0);
  assert.equal(f.writes[0]?.outputTokens, 0);
  assert.equal(f.writes[0]?.durationMs, 0);
});
