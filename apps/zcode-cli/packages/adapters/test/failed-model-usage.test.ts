import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, createModelUsageSummaryFromEvents } from "@zcode/contracts";
import { recordModelUsageFact } from "../../core/src/runtime/methods/usage-observability.js";

const usage = { inputTokens: 8, outputTokens: 0, totalTokens: 8 };
const event = {
  type: SessionEventType.ModelNetworkStatus,
  payload: { type: "model_request_failed", reason: "context_exceeded", usage, requestId: "fixture-request" },
  timestamp: new Date(),
} as never;

test("failed provider usage is included once without doubling completed model usage", () => {
  const complete = { type: SessionEventType.ModelComplete, payload: { usage }, timestamp: new Date() } as never;
  const summary = createModelUsageSummaryFromEvents([event, complete]);
  assert.equal(summary?.inputTokens, 16);
  assert.equal(summary?.totalTokens, 16);
});

test("usage store receives the failed request usage from the same network event", async () => {
  let fact: any;
  await recordModelUsageFact({
    sessionId: "fixture-session", config: {}, sessionStore: {
      recordModelUsage: async (input: any) => { fact = input; },
      upsertTurnUsage: async () => {}, upsertToolUsage: async () => {}, pruneUsage: async () => {},
    },
  } as never, {
    events: [event], model: { providerId: "fixture", modelId: "fixture", options: {} },
    networkEventStartIndex: 0, querySource: "main_turn", startedAt: Date.now(), status: "error",
    traceContext: { traceId: "fixture", spanId: "fixture" },
  } as never);
  assert.equal(fact.inputTokens, 8);
  assert.equal(fact.providerTotalTokens, 8);
});
