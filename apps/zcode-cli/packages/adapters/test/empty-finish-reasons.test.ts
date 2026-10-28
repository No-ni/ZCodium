import assert from "node:assert/strict";
import test from "node:test";
import { ModelErrorCode } from "@zcode/contracts";
import * as diagnostics from "../src/model/runner-diagnostics.js";
import { runGenerateText } from "../src/model/runner-generate.js";
import { runStreamText } from "../src/model/runner-stream.js";
import { resolveAiSdkModelRetryOptions } from "../src/model/retry-policy.js";

const usage = { inputTokens: 8, outputTokens: 0, totalTokens: 8 };
const resolved = {
  providerId: "fixture-provider", modelId: "fixture-model", providerKind: "google",
  properties: {}, model: {},
} as never;

function fixture(finishReason: string, rawFinishReason: string, text = "") {
  const statuses: Array<{ type: string; usage?: unknown }> = [];
  let calls = 0;
  const chunks = [
    { type: "start" },
    ...(text ? [{ type: "text-delta", id: "text", text }] : []),
    { type: "finish", finishReason, providerMetadata: { rawFinishReason }, totalUsage: usage },
  ];
  const result = {
    text, finishReason, rawFinishReason, providerMetadata: { rawFinishReason },
    reasoning: [], toolCalls: [], toolResults: [], sources: [], totalUsage: usage,
  };
  const input = {
    env: {}, resolved, resolveModel: () => resolved,
    request: { messages: [{ role: "user", content: "fixture" }] },
    retry: resolveAiSdkModelRetryOptions({ maxAttempts: 2 }, {}),
    statusSink: { publish: (event: { type: string; usage?: unknown }) => { statuses.push(event); } },
    runtime: {
      generateText: async () => { calls += 1; return result; },
      streamText: () => {
        calls += 1;
        return { fullStream: (async function* () { yield* chunks; })(), response: Promise.resolve({ headers: {} }) };
      },
    },
    streamIdleTimeoutMs: 500,
  };
  return { input, statuses, calls: () => calls };
}

test("clear empty context finish has one failed terminal and preserves usage in generate", async () => {
  const f = fixture("other", "context_window_exceeded");
  await assert.rejects(runGenerateText(f.input as never), (error: any) => {
    assert.equal(error.code, ModelErrorCode.ModelContextExceeded);
    assert.equal(error.usage.inputTokens, usage.inputTokens);
    assert.equal(error.usage.totalTokens, usage.totalTokens);
    return true;
  });
  assert.equal(f.calls(), 1);
  assert.equal(f.statuses.filter((s) => s.type === "model_request_failed").length, 1);
  assert.ok(!f.statuses.some((s) => s.type === "model_request_completed"));
});

test("clear empty context finish never publishes stream finish before failing", async () => {
  const f = fixture("other", "context_length_exceeded");
  const events: any[] = [];
  await assert.rejects(async () => {
    for await (const event of runStreamText(f.input as never)) events.push(event);
  }, (error: any) => {
    assert.equal(error.code, ModelErrorCode.ModelContextExceeded);
    assert.equal(error.usage.inputTokens, usage.inputTokens);
    assert.equal(error.usage.totalTokens, usage.totalTokens);
    return true;
  });
  assert.equal(f.calls(), 1);
  assert.ok(!events.some((event) => event.type === "finish"));
  assert.equal(f.statuses.filter((s) => s.type === "model_request_failed").length, 1);
  assert.ok(!f.statuses.some((s) => s.type === "model_request_completed"));
});

test("partial content keeps the existing finish and is not reinterpreted", async () => {
  const f = fixture("other", "context_exceeded", "partial");
  const result = await runGenerateText(f.input as never);
  assert.equal(result.text, "partial");
  assert.equal(f.calls(), 1);
  const stream: any[] = [];
  for await (const event of runStreamText(f.input as never)) stream.push(event);
  assert.ok(stream.some((event) => event.type === "text_delta" && event.text === "partial"));
  assert.ok(stream.some((event) => event.type === "finish"));
});

test("refusal, content filtering and context reasons never trigger generic empty retry", () => {
  for (const reason of ["refusal", "content-filter", "content_filter", "context_exceeded", "PROMPT_TOO_LONG"]) {
    assert.equal(diagnostics.isZeroOutputModelCompletion({
      finishReason: "other", rawFinishReason: reason, reasoningLength: 0,
      textLength: 0, toolCallCount: 0,
    } as never), false, reason);
  }
  assert.equal(diagnostics.isZeroOutputModelCompletion({
    finishReason: "other", reasoningLength: 0, textLength: 0, toolCallCount: 0,
  }), true);
});
