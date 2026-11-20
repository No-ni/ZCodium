import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import { localGenerationFactSchema } from "@zcode/shared/extension-host";
import { deriveLocalGenerationFact } from "../src/zcode-protocol-v4/local-generation/contract.js";

function event(type: SessionEvent["type"], payload: unknown): SessionEvent {
  return {
    id: "event",
    sessionId: "session",
    turnId: "turn",
    traceId: "trace",
    sequenceNumber: 1,
    timestamp: new Date(1000),
    type,
    payload,
  } as SessionEvent;
}
const status = {
  type: "model_request_completed",
  querySource: "main_turn",
  requestId: "request",
  providerId: "provider",
  modelId: "model",
  durationMs: 2000,
  timeToFirstContentMs: 400,
  usage: { outputTokens: 320 },
  baseURL: "https://provider.invalid",
  requestHeaders: { authorization: "fixture" },
  message: "private error",
  requestBody: "private prompt",
};

test("local generation emits only strict scalar metrics from real completed events", () => {
  const result = deriveLocalGenerationFact(
    "instance",
    "session",
    event(SessionEventType.ModelNetworkStatus, status),
  );
  assert.deepEqual(result, {
    version: 1,
    instanceId: "instance",
    eventId: "event",
    sessionId: "session",
    occurredAt: 1000,
    kind: "completed",
    requestId: "request",
    providerId: "provider",
    modelId: "model",
    durationMs: 2000,
    timeToFirstContentMs: 400,
    outputTokens: 320,
  });
  assert.ok(localGenerationFactSchema.safeParse(result).success);
  assert.equal(
    localGenerationFactSchema.safeParse({ ...result, requestHeaders: {} }).success,
    false,
  );
  assert.equal(
    localGenerationFactSchema.safeParse({ ...result, durationMs: Infinity }).success,
    false,
  );
  assert.equal(localGenerationFactSchema.safeParse({ ...result, outputTokens: -1 }).success, false);
});

test("local generation excludes side requests, child output and tool input", () => {
  for (const querySource of ["compact", "session_title", undefined]) {
    assert.equal(
      deriveLocalGenerationFact(
        "instance",
        "session",
        event(SessionEventType.ModelNetworkStatus, { ...status, querySource }),
      ),
      null,
    );
  }
  assert.equal(
    deriveLocalGenerationFact(
      "instance",
      "session",
      event(SessionEventType.ModelNetworkStatus, { ...status, toolCallId: "parent" }),
    ),
    null,
  );
  for (const payload of [
    { kind: "tool_input_delta", delta: "private" },
    { kind: "text_delta", delta: "private", _meta: { zcode: { parentToolCallId: "parent" } } },
  ]) {
    assert.equal(
      deriveLocalGenerationFact(
        "instance",
        "session",
        event(SessionEventType.ModelStreaming, payload),
      ),
      null,
    );
  }
  for (const kind of ["text_delta", "reasoning_delta"]) {
    const fact = deriveLocalGenerationFact(
      "instance",
      "session",
      event(SessionEventType.ModelStreaming, { kind, delta: "abc" }),
    );
    assert.equal(fact?.kind, "chunk");
    assert.equal(fact && "chars" in fact ? fact.chars : undefined, 3);
    assert.equal(JSON.stringify(fact).includes("abc"), false);
  }
});
