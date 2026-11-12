import assert from "node:assert/strict";
import test from "node:test";
import { mergePartialStreamUsage } from "../src/model/stream-usage/index.js";
import {
  anthropicUsageFrames,
  createPartialUsageWireFixture,
  PARTIAL_USAGE_INPUT,
  type PartialUsageProtocol,
} from "./fixtures/model-partial-usage.js";

async function failed(fixture: ReturnType<typeof createPartialUsageWireFixture>) {
  await assert.rejects(fixture.run());
  const failures = fixture.statuses.filter((event) => event.type === "model_request_failed");
  assert.equal(failures.length, 1, "one terminal belongs to one physical request");
  assert.equal(
    fixture.statuses.some((event) => event.type === "model_request_completed"),
    false,
  );
  assert.ok(
    fixture.sdkChunkTypes.includes("text-delta"),
    "the real SDK consumed the usage prefix before interruption",
  );
  return failures[0]!;
}

for (const protocol of [
  "anthropic",
  "google",
  "openai-chat",
  "openai-responses",
  "openai-compatible",
] as const satisfies readonly PartialUsageProtocol[]) {
  test(`${protocol}: reported input and true zero cache survive cancellation before finish-step`, async () => {
    const fixture = createPartialUsageWireFixture({ protocol });
    const terminal = await failed(fixture);
    assert.equal(terminal.reason, "cancelled");
    assert.equal(fixture.requests, 1);
    assert.equal(
      fixture.sdkChunkTypes.includes("finish-step"),
      false,
      "this regression must reach the unfinished-step gap",
    );
    assert.equal(terminal.usage?.inputTokens, PARTIAL_USAGE_INPUT);
    assert.equal(terminal.usage?.outputTokens, 0);
    assert.equal(terminal.usage?.cacheReadTokens, 0);
    assert.equal(terminal.usage?.cacheWriteTokens, protocol === "anthropic" ? 0 : undefined);
    assert.equal(
      terminal.usage?.totalTokens,
      undefined,
      "raw did not report total; partial accounting must not fabricate it",
    );
  });
}

test("Anthropic: absent cache remains unknown on an actually consumed cancelled stream", async () => {
  const fixture = createPartialUsageWireFixture({ frames: anthropicUsageFrames() });
  const terminal = await failed(fixture);
  assert.equal(terminal.usage?.inputTokens, PARTIAL_USAGE_INPUT);
  assert.equal(terminal.usage?.outputTokens, 0);
  assert.equal(terminal.usage?.cacheReadTokens, undefined);
  assert.equal(terminal.usage?.cacheWriteTokens, undefined);
  assert.equal(terminal.usage?.totalTokens, undefined);
});

test("Anthropic: reported prefix cost survives disconnect independently of cancellation", async () => {
  const fixture = createPartialUsageWireFixture({
    mode: "disconnect",
    frames: anthropicUsageFrames({ cache: 37 }),
  });
  const terminal = await failed(fixture);
  assert.notEqual(terminal.reason, "cancelled");
  assert.equal(terminal.usage?.inputTokens, PARTIAL_USAGE_INPUT + 37 + 11);
  assert.equal(terminal.usage?.cacheReadTokens, 37);
  assert.equal(terminal.usage?.cacheWriteTokens, 11);
});

test("Anthropic: successive cumulative usage frames replace fields rather than summing them", async () => {
  const fixture = createPartialUsageWireFixture({
    abortAfterUsageDeltas: 2,
    frames: anthropicUsageFrames({
      cache: 0,
      updates: [
        { output_tokens: 12, cache_read_input_tokens: 13, cache_creation_input_tokens: 11 },
        { input_tokens: 4900, output_tokens: 24, cache_read_input_tokens: 37 },
      ],
    }),
  });
  const terminal = await failed(fixture);
  assert.equal(
    fixture.consumedUsageDeltas,
    2,
    "both real SDK raw updates were consumed before abort",
  );
  assert.equal(terminal.usage?.inputTokens, 4900 + 37 + 11);
  assert.equal(terminal.usage?.outputTokens, 24);
  assert.equal(terminal.usage?.cacheReadTokens, 37);
  assert.equal(terminal.usage?.cacheWriteTokens, 11);
  assert.equal(terminal.usage?.totalTokens, undefined);
});

test("Anthropic: complete step replaces partial usage and status matches the returned finish", async () => {
  const fixture = createPartialUsageWireFixture({
    mode: "complete",
    frames: anthropicUsageFrames({ cache: 37, complete: true }),
  });
  const usage = await fixture.run();
  assert.equal(fixture.requests, 1);
  assert.equal(usage?.inputTokens, PARTIAL_USAGE_INPUT + 37 + 11);
  assert.equal(usage?.outputTokens, 23);
  assert.equal(usage?.totalTokens, PARTIAL_USAGE_INPUT + 37 + 11 + 23);
  const terminals = fixture.statuses.filter((event) => event.type === "model_request_completed");
  assert.equal(terminals.length, 1);
  assert.deepEqual(terminals[0]!.usage, usage);
  assert.equal(fixture.sdkChunkTypes.filter((type) => type === "finish-step").length, 1);
});

test("completed step plus interrupted step counts both inputs while preserving the first cache gap", async () => {
  const fixture = createPartialUsageWireFixture({
    completedFirstStep: {},
    frames: anthropicUsageFrames({ cache: 37 }),
  });
  const terminal = await failed(fixture);
  assert.equal(fixture.requests, 2);
  assert.equal(fixture.sdkChunkTypes.filter((type) => type === "finish-step").length, 1);
  assert.equal(terminal.usage?.inputTokens, PARTIAL_USAGE_INPUT * 2 + 37 + 11);
  assert.equal(terminal.usage?.outputTokens, 23);
  assert.equal(
    terminal.usage?.cacheReadTokens,
    undefined,
    "known later cache cannot erase an earlier step's unknown cache",
  );
  assert.equal(terminal.usage?.cacheWriteTokens, undefined);
  assert.equal(
    terminal.usage?.totalTokens,
    undefined,
    "a partial step has no reported complete total",
  );
});

test("no raw usage is reported: interrupted OpenAI text does not manufacture a zero ledger", async () => {
  const fixture = createPartialUsageWireFixture({ protocol: "openai-chat", reportUsage: false });
  const terminal = await failed(fixture);
  assert.equal(terminal.usage, undefined);
});

test("partial numeric collector follows the Provider and actual chat envelope, not similar foreign fields", () => {
  const usage = mergePartialStreamUsage({
    providerKind: "openai",
    rawValue: {
      object: "chat.completion.chunk",
      usage: {
        prompt_tokens: 17,
        completion_tokens: 0,
        total_tokens: 17,
        input_tokens: 999,
        output_tokens: 999,
        cache_creation_input_tokens: 999,
        input_tokens_details: { cached_tokens: 999 },
        prompt_tokens_details: { cached_tokens: 0 },
        server_tool_use: { web_search_requests: 999 },
      },
    },
  });
  assert.equal(usage?.inputTokens, 17);
  assert.equal(usage?.outputTokens, 0);
  assert.equal(usage?.raw?.input_tokens, undefined);
  assert.equal(usage?.raw?.input_tokens_details, undefined);
  assert.equal(usage?.raw?.server_tool_use, undefined);
  assert.deepEqual(usage?.raw?.prompt_tokens_details, { cached_tokens: 0 });
});

test("Google partial metadata cannot introduce Anthropic cache, server tools or foreign token totals", () => {
  const usage = mergePartialStreamUsage({
    providerKind: "google",
    rawValue: {
      usageMetadata: {
        promptTokenCount: 19,
        candidatesTokenCount: 0,
        input_tokens: 999,
        cache_read_input_tokens: 999,
        server_tool_use: { web_fetch_requests: 999 },
      },
    },
  });
  assert.equal(usage?.inputTokens, 19);
  assert.equal(usage?.raw?.cache_read_input_tokens, undefined);
  assert.equal(usage?.raw?.server_tool_use, undefined);
  assert.equal(usage?.totalTokens, undefined);
  assert.equal(
    mergePartialStreamUsage({
      providerKind: "unknown",
      rawValue: { usageMetadata: { promptTokenCount: 19 } },
    }),
    undefined,
  );
});

test("null or invalid cumulative fields remain unknown; a later true zero is a reported fact", () => {
  const first = mergePartialStreamUsage({
    providerKind: "anthropic",
    rawValue: {
      type: "message_start",
      message: { usage: { input_tokens: 20, output_tokens: 0, cache_read_input_tokens: 7 } },
    },
  });
  const invalid = mergePartialStreamUsage({
    providerKind: "anthropic",
    previous: first,
    rawValue: {
      type: "message_delta",
      usage: { output_tokens: -1, cache_read_input_tokens: null, total_tokens: "99" },
    },
  });
  assert.equal(invalid?.outputTokens, undefined);
  assert.equal(invalid?.totalTokens, undefined);
  assert.equal(invalid?.raw?.cache_read_input_tokens, null);
  const zero = mergePartialStreamUsage({
    providerKind: "anthropic",
    previous: invalid,
    rawValue: {
      type: "message_delta",
      usage: { output_tokens: 0, cache_read_input_tokens: 0 },
    },
  });
  assert.equal(zero?.outputTokens, 0);
  assert.equal(zero?.inputTokens, 20);
  assert.equal(zero?.raw?.cache_read_input_tokens, 0);
});
