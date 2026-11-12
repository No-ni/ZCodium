import assert from "node:assert/strict";
import test from "node:test";
import {
  createCacheUsageWireFixture,
  type CacheProtocol,
  type CacheValue,
} from "./fixtures/model-cache-usage.js";

const protocols: readonly CacheProtocol[] = [
  "anthropic",
  "google",
  "openai-chat",
  "openai-responses",
  "openai-compatible",
];
const cases: ReadonlyArray<{ name: string; value: CacheValue; expected: number | undefined }> = [
  { name: "missing", value: undefined, expected: undefined },
  { name: "null", value: null, expected: undefined },
  { name: "real zero", value: 0, expected: 0 },
  { name: "reported hit", value: 37, expected: 37 },
];

for (const protocol of protocols) {
  for (const mode of ["stream", "generate"] as const) {
    for (const sample of cases) {
      test(`${protocol} ${mode}: cache ${sample.name} keeps provider field presence`, async () => {
        const fixture = createCacheUsageWireFixture(protocol, mode, sample.value);
        const usage = await fixture.run();
        assert.ok(usage, "a complete response must expose its normalized usage");
        const cacheWrite =
          protocol === "anthropic" ? (sample.expected === 37 ? 11 : sample.expected) : undefined;
        const input =
          100 + (protocol === "anthropic" ? (sample.expected ?? 0) + (cacheWrite ?? 0) : 0);
        assert.equal(
          usage.cacheReadTokens,
          sample.expected,
          "missing/null cache is not a reported zero",
        );
        assert.equal(
          usage.cacheWriteTokens,
          cacheWrite,
          "creation and read use distinct provider fields",
        );
        assert.equal(
          usage.inputTokens,
          input,
          "SDK-normalized input already includes applicable cache tokens",
        );
        assert.equal(usage.outputTokens, 2);
        assert.equal(usage.totalTokens, input + 2);
        assert.equal(fixture.requests.length, 1);
        const terminals = fixture.statuses.filter(
          (event) => event.type === "model_request_completed",
        );
        assert.equal(terminals.length, 1);
        assert.deepEqual(
          terminals[0]!.usage,
          usage,
          "status and returned finish must share usage facts",
        );
      });
    }
  }
}

for (const mode of ["stream", "generate"] as const) {
  for (const secondCache of [undefined, 0] as const) {
    test(`anthropic ${mode}: two real SDK steps retain totals and ${secondCache === undefined ? "unknown" : "known"} cache coverage`, async () => {
      const fixture = createCacheUsageWireFixture("anthropic", mode, 37, {
        secondStep: { cache: secondCache },
      });
      const usage = await fixture.run();
      assert.ok(usage);
      assert.equal(fixture.requests.length, 2, "SDK must actually complete both tool steps");
      assert.equal(usage.inputTokens, 248, "last-step raw usage cannot replace the two-step total");
      assert.equal(usage.outputTokens, 4);
      assert.equal(usage.totalTokens, 252);
      assert.equal(usage.cacheReadTokens, secondCache === undefined ? undefined : 37);
      assert.equal(usage.cacheWriteTokens, secondCache === undefined ? undefined : 11);
      const terminal = fixture.statuses.findLast(
        (event) => event.type === "model_request_completed",
      );
      assert.deepEqual(terminal?.usage, usage);
    });
  }
}

for (const failureKind of ["throw", "chunk"] as const) {
  for (const cache of [undefined, 37] as const) {
    test(`stream ${failureKind} after a real SDK step retains ${cache === undefined ? "unknown" : "known"} cache and reported usage`, async () => {
      const fixture = createCacheUsageWireFixture("anthropic", "stream", cache, {
        failAfterStep: true,
        failureKind,
      });
      await assert.rejects(fixture.run());
      const failed = fixture.statuses.filter((event) => event.type === "model_request_failed");
      assert.equal(failed.length, 1);
      const input = cache === undefined ? 100 : 148;
      assert.equal(
        failed[0]!.usage?.inputTokens,
        input,
        "reported step usage survives the later stream failure",
      );
      assert.equal(failed[0]!.usage?.outputTokens, 2);
      assert.equal(failed[0]!.usage?.totalTokens, input + 2);
      assert.equal(failed[0]!.usage?.cacheReadTokens, cache);
      assert.equal(
        fixture.statuses.some((event) => event.type === "model_request_completed"),
        false,
      );
    });
  }
}
