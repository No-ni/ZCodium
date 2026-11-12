import assert from "node:assert/strict";
import test from "node:test";
import {
  createModelId,
  createModelProviderId,
  createSessionEvent,
  createSessionId,
  ModelTransportKind,
  SessionEventType,
  type ModelNetworkStatusEvent,
  type SessionEvent,
  type TraceContext,
} from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { createModelStatusSink } from "../src/runtime/methods/model-status.js";

const SESSION = createSessionId("status-fixture");
const TRACE = { traceId: "fixture-trace", spanId: "fixture-span" } as TraceContext;
const started = {
  type: "model_request_started",
  timestamp: new Date(100).toISOString(),
  traceId: TRACE.traceId,
  requestId: "physical-status",
  providerId: createModelProviderId("fixture-provider"),
  modelId: createModelId("fixture-model"),
  transport: ModelTransportKind.Sse,
  attempt: 1,
  maxAttempts: 3,
} satisfies ModelNetworkStatusEvent;
function fixture(order: string[], append?: () => void) {
  return {
    createEvent: (
      type: typeof SessionEventType.ModelNetworkStatus,
      payload: ModelNetworkStatusEvent,
    ) => createSessionEvent(type, SESSION, payload),
    logModelNetworkStatus: () => {
      order.push("log");
    },
    appendEvent: async () => {
      order.push("append");
      append?.();
    },
  } as unknown as AgentRuntimeInternal;
}

test("model status publication awaits the native callback before appending its network event", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const order: string[] = [];
  const events: SessionEvent[] = [];
  const sink = createModelStatusSink.call(fixture(order), TRACE, events, {
    onStatus: async () => {
      order.push("track-start");
      await gate;
      order.push("track-end");
    },
  });
  const pending = Promise.resolve(sink.publish(started));
  await Promise.resolve();
  assert.deepEqual(order, ["track-start"]);
  assert.equal(events.length, 0);
  release();
  await pending;
  assert.deepEqual(order, ["track-start", "track-end", "log", "append"]);
  assert.equal(events.length, 1);
});

test("a failed native callback still preserves the actual network event for usage accounting", async () => {
  const events: SessionEvent[] = [];
  const sink = createModelStatusSink.call(fixture([]), TRACE, events, {
    onStatus: async () => {
      throw new Error("synthetic observation failure");
    },
  });
  await assert.rejects(async () => sink.publish(started), /synthetic observation failure/u);
  assert.equal(events.length, 1);
  assert.equal((events[0]?.payload as ModelNetworkStatusEvent).requestId, "physical-status");
});

test("an event persistence failure cannot remove its in-memory model usage identity", async () => {
  const events: SessionEvent[] = [];
  const sink = createModelStatusSink.call(
    fixture([], () => {
      throw new Error("synthetic event persistence failure");
    }),
    TRACE,
    events,
  );
  await assert.rejects(async () => sink.publish(started), /synthetic event persistence failure/u);
  assert.equal(events.length, 1);
});

test("existing synchronous callbacks retain their order and non-persisted sampling keeps an in-memory event", async () => {
  const order: string[] = [];
  const events: SessionEvent[] = [];
  const sink = createModelStatusSink.call(fixture(order), TRACE, events, {
    persist: false,
    onStatus: () => {
      order.push("track");
    },
  });
  await sink.publish(started);
  assert.deepEqual(order, ["track", "log"]);
  assert.equal(events.length, 1);
});
