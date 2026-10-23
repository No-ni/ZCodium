import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { modelMessageContentToText, type ModelMessageContent } from "@zcode/contracts";
import { DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY } from "@zcode/shared";
import {
  estimateMessageTokens,
  getMessagesToSummarize,
  hasEnoughMessagesToCompact,
  type CompactModelMessage,
} from "../src/compact/manual.js";
import {
  DEFAULT_COMPACT_CONTEXT_WINDOW,
  DEFAULT_AUTOCOMPACT_THRESHOLD_PERCENT,
  MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
  getAutoCompactOutputReserveTokens,
  getAutoCompactThreshold,
  getEffectiveContextWindowSize,
  shouldAutoCompact,
} from "../src/compact/policy.js";

// 固定原准备度算法：保留前缀过滤、浅克隆和每个 assistant 开启新轮次。
function legacyReady(messages: readonly CompactModelMessage[]): boolean {
  const body = messages
    .filter(
      (message) =>
        !(
          message.role === "system" ||
          (message.role === "user" &&
            modelMessageContentToText(message.content).trimStart().startsWith("<system-reminder>"))
        ),
    )
    .map((message) => ({ ...message }));
  const groups: CompactModelMessage[][] = [];
  let current: CompactModelMessage[] = [];
  for (const message of body) {
    if (message.role === "assistant" && current.length > 0) {
      groups.push(current);
      current = [message];
    } else current.push(message);
  }
  if (current.length > 0) groups.push(current);
  return groups.length >= 2 && body.some((message) => message.role === "assistant");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

const contents: ModelMessageContent[] = [
  "",
  "ordinary text",
  "\t <system-reminder>context</system-reminder>",
  "literal prefix <system-reminder>",
  "\uFEFF\n<system-reminderish>",
  [{ type: "text", text: "<system-reminder>" }],
  [{ type: "reasoning", text: "hidden", providerOptions: { fixture: { safe: true } } }],
  [
    { type: "reasoning", text: "hidden" },
    { type: "text", text: "\n <system-reminder>metadata" },
  ],
  [
    { type: "text", text: "" },
    { type: "text", text: "body" },
  ],
];

const roles = ["system", "user", "assistant", "tool", "other"];
function message(role: string, content: ModelMessageContent = ""): CompactModelMessage {
  return { role, content };
}

for (const [name, messages, expected] of [
  ["empty", [], false],
  ["single assistant", [message("assistant")], false],
  ["assistant and trailing user", [message("assistant"), message("user")], false],
  ["tool before assistant", [message("tool"), message("assistant")], true],
  ["adjacent assistants", [message("assistant"), message("assistant")], true],
  ["two users without assistant", [message("user"), message("user")], false],
  [
    "only prefixes before assistant",
    [message("system"), message("user", " <system-reminder>"), message("assistant")],
    false,
  ],
  [
    "prefixes interspersed between rounds",
    [
      message("user"),
      message("system"),
      message("assistant"),
      message("user", "<system-reminder>"),
    ],
    true,
  ],
] as const) {
  test(`compact readiness preserves ${name}`, () => {
    const frozen = deepFreeze(messages);
    assert.equal(legacyReady(frozen), expected);
    assert.equal(hasEnoughMessagesToCompact(frozen), expected);
    assert.deepEqual(messages, frozen);
  });
}

test("readiness matches every role pair and structured prefix combination", () => {
  for (const first of roles)
    for (const second of roles)
      for (const firstContent of contents)
        for (const secondContent of contents) {
          const messages = deepFreeze([
            message(first, firstContent),
            message(second, secondContent),
          ]);
          assert.equal(hasEnoughMessagesToCompact(messages), legacyReady(messages));
        }
});

test("readiness matches fixed-seed long histories without changing references or fields", () => {
  let seed = 0x7310ac;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  for (let sample = 0; sample < 1000; sample++) {
    const count = next() % 150;
    const messages = Array.from({ length: count }, () =>
      message(roles[next() % roles.length]!, contents[next() % contents.length]!),
    );
    if (messages.length > 2) messages[2] = messages[0]!;
    const original = structuredClone(messages);
    deepFreeze(messages);
    assert.equal(hasEnoughMessagesToCompact(messages), legacyReady(messages));
    assert.deepEqual(messages, original);
  }
});

test("readiness preserves skipped sparse slots and duplicate message references", () => {
  const messages: CompactModelMessage[] = [];
  messages.length = 6;
  messages[1] = message("user", "body");
  messages[5] = message("assistant", "response");
  deepFreeze(messages);
  assert.equal(legacyReady(messages), true);
  assert.equal(hasEnoughMessagesToCompact(messages), true);
  const assistant = deepFreeze(message("assistant"));
  assert.equal(
    hasEnoughMessagesToCompact([assistant, assistant]),
    legacyReady([assistant, assistant]),
  );
});

test("getMessagesToSummarize retains its separate shallow-copy contract", () => {
  const input = deepFreeze([
    message("system", "prefix"),
    message("user", "<system-reminder>prefix"),
    {
      role: "assistant",
      content: [{ type: "text", text: "body" }] as ModelMessageContent,
      toolCalls: [{ name: "Read", input: { file: "fixture.ts" } }],
      extension: { present: true },
    },
    message("user", "reply"),
  ]);
  const summary = getMessagesToSummarize(input);
  assert.deepEqual(summary, input.slice(2));
  assert.notEqual(summary, input);
  assert.notEqual(summary[0], input[2]);
  assert.equal(summary[0]!.content, input[2]!.content);
  assert.equal(summary[0]!.toolCalls, input[2]!.toolCalls);
});

test("the entire input retains original prefix validation after readiness is satisfied", () => {
  const failure = new Error("fixture invalid user content");
  let reads = 0;
  const content: ModelMessageContent = [
    {
      type: "text",
      get text(): string {
        reads++;
        throw failure;
      },
    },
  ];
  const messages = [message("user"), message("assistant"), message("user", content)];
  assert.throws(
    () => legacyReady(messages),
    (error) => error === failure,
  );
  assert.throws(
    () => hasEnoughMessagesToCompact(messages),
    (error) => error === failure,
  );
  assert.equal(reads, 2);
});

function irrelevantFieldWork(check: typeof hasEnoughMessagesToCompact): number {
  let reads = 0;
  const messages = Array.from({ length: 2000 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: "",
    get toolCalls() {
      reads++;
      return [{ name: "Read", input: { file: "fixture.ts" } }];
    },
    get extension() {
      reads++;
      return { fixture: true };
    },
  }));
  deepFreeze(messages);
  reads = 0;
  assert.equal(check(messages), true);
  return reads;
}

test("compact readiness does not copy unrelated tool input and extension fields", (context) => {
  const oldReads = irrelevantFieldWork(legacyReady);
  const currentReads = irrelevantFieldWork(hasEnoughMessagesToCompact);
  assert.equal(oldReads, 4000);
  assert.equal(currentReads, 0, JSON.stringify({ oldReads, currentReads }));
  context.diagnostic(JSON.stringify({ messages: 2000, oldReads, currentReads }));
});

function legacyPolicy(input: Parameters<typeof shouldAutoCompact>[0]) {
  const positiveInt = (value: number | undefined) =>
    value === undefined || !Number.isFinite(value) || value < 0 ? undefined : Math.floor(value);
  const config = input.config ?? {};
  const contextWindow = positiveInt(config.contextWindow) ?? DEFAULT_COMPACT_CONTEXT_WINDOW;
  const tokenOverride = input.tokenOverride;
  const estimatedTokenCount = estimateMessageTokens(input.messages);
  const tokenCount = tokenOverride?.tokenCount ?? estimatedTokenCount;
  const threshold = getAutoCompactThreshold(config);
  const common = {
    contextWindow,
    effectiveContextWindow: getEffectiveContextWindowSize(config),
    estimatedTokenCount,
    providerCacheReadTokens: tokenOverride?.cacheReadTokens,
    providerCacheWriteTokens: tokenOverride?.cacheWriteTokens,
    maxOutputTokens: positiveInt(config.maxOutputTokens),
    modelContextBudgetStrategy: DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
    outputReserveTokens: Math.min(getAutoCompactOutputReserveTokens(config), contextWindow),
    providerBaseTokenCount: tokenOverride?.baseTokenCount,
    providerContextUsageTokenCount: tokenOverride?.contextUsageTokenCount,
    providerIncrementalTokenCount: tokenOverride?.incrementalTokenCount,
    providerOutputTokens: tokenOverride?.outputTokens,
    threshold,
    thresholdPercent: DEFAULT_AUTOCOMPACT_THRESHOLD_PERCENT,
    tokenCount,
    tokenSource: tokenOverride?.source ?? "estimate",
  };
  if (config.enabled === false) return { ...common, shouldCompact: false, reason: "disabled" };
  if (!legacyReady(input.messages))
    return { ...common, shouldCompact: false, reason: "not_enough_messages" };
  const maxFailures =
    positiveInt(config.maxConsecutiveFailures) ?? MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES;
  if ((input.consecutiveFailures ?? 0) >= maxFailures)
    return { ...common, shouldCompact: false, reason: "circuit_breaker" };
  if (tokenCount < threshold) return { ...common, shouldCompact: false, reason: "below_threshold" };
  return { ...common, shouldCompact: true, reason: "above_threshold" };
}

test("auto-compact full decisions retain estimates, provider usage and failure precedence", () => {
  const inputs = [
    [],
    [message("assistant")],
    [message("user", "body"), message("assistant", "response")],
  ];
  for (const messages of inputs)
    for (const enabled of [undefined, false, true])
      for (const consecutiveFailures of [0, 2, 3, 9])
        for (const contextWindow of [0, 100, 200_000, NaN, Infinity])
          for (const override of [false, true]) {
            const input = deepFreeze({
              messages,
              config: { enabled, contextWindow, bufferTokens: 13, maxOutputTokens: 32 },
              consecutiveFailures,
              ...(override
                ? {
                    tokenOverride: {
                      source: "provider_usage" as const,
                      tokenCount: 71,
                      baseTokenCount: 65,
                      incrementalTokenCount: 6,
                      cacheReadTokens: 5,
                      cacheWriteTokens: 3,
                      outputTokens: 2,
                      contextUsageTokenCount: 68,
                    },
                  }
                : {}),
            });
            assert.deepEqual(shouldAutoCompact(input), legacyPolicy(input));
          }
});

const benchmarkRequested = process.execArgv.some(
  (value) => value.includes("test-name-pattern") && value.includes("benchmark"),
);
test(
  "benchmark: compact readiness without full-message copies",
  { skip: !benchmarkRequested },
  (context) => {
    for (const count of [16, 1000, 10_000]) {
      const messages = Array.from({ length: count }, (_, index) => ({
        role: index % 2 ? "assistant" : "user",
        content: "body",
        toolCalls: [{ name: "Read", input: { file: "fixture.ts" } }],
        extension: { fixture: true },
      }));
      const oldTimes: number[] = [];
      const newTimes: number[] = [];
      const repetitions = count === 16 ? 10_000 : 50;
      for (let index = 0; index < 6; index++) {
        legacyReady(messages);
        hasEnoughMessagesToCompact(messages);
      }
      for (let index = 0; index < 15; index++) {
        const pair =
          index % 2
            ? ([
                [hasEnoughMessagesToCompact, newTimes],
                [legacyReady, oldTimes],
              ] as const)
            : ([
                [legacyReady, oldTimes],
                [hasEnoughMessagesToCompact, newTimes],
              ] as const);
        for (const [check, samples] of pair) {
          const start = performance.now();
          for (let iteration = 0; iteration < repetitions; iteration++)
            assert.equal(check(messages), true);
          samples.push((performance.now() - start) / repetitions);
        }
      }
      const median = (values: number[]) =>
        values.toSorted((left, right) => left - right)[Math.floor(values.length / 2)]!;
      context.diagnostic(
        JSON.stringify({ messages: count, oldMs: median(oldTimes), newMs: median(newTimes) }),
      );
    }
  },
);
