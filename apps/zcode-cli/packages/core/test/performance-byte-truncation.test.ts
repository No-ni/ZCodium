import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import type { ModelMessageContent, TraceContext } from "@zcode/contracts";
import {
  appendHookToStringContent,
  fitContentWithSuffix,
  projectHookAugmentedModelContent,
} from "../src/tool/executor/result-content-projection.js";
import { serializeOutput } from "../src/tool/executor/result-serialization.js";
import type { ToolExecutorDeps } from "../src/tool/executor/types.js";
import type { ToolEntry } from "../src/tool/types.js";

// 固定 bcdb14b1 的旧算法，不能随生产实现修改 oracle 的参数或字符边界。
function legacyFitStringToBytes(
  value: string,
  maxBytes: number,
  direction: "head" | "tail",
): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const chars = Array.from(value);
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate =
      direction === "tail"
        ? chars.slice(chars.length - mid).join("")
        : chars.slice(0, mid).join("");
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return direction === "tail"
    ? chars.slice(chars.length - low).join("")
    : chars.slice(0, low).join("");
}

function legacyFitContentWithSuffix(
  content: string,
  maxBytes: number,
  suffix: string,
  direction: "head" | "tail",
): string {
  if (maxBytes <= 0) return "";
  const suffixContent = legacyFitStringToBytes(suffix, maxBytes, "head");
  const remainingBytes = maxBytes - Buffer.byteLength(suffixContent, "utf8");
  if (remainingBytes <= 0) return suffixContent;
  return `${legacyFitStringToBytes(content, remainingBytes, direction)}${suffixContent}`;
}

const DIRECTIONS = ["head", "tail"] as const;
const BUDGETS = [
  -Infinity,
  -10,
  -0.5,
  -0,
  0,
  Number.MIN_VALUE,
  0.5,
  0.99,
  1,
  1.5,
  2,
  2.99,
  3,
  3.5,
  4,
  4.5,
  5,
  7,
  8,
  12,
  16,
  31,
  Infinity,
  NaN,
];
const TEXTS = [
  "",
  "ascii",
  "中文",
  "😀😃",
  "a中文😀z",
  "\ud800",
  "\udc00",
  "\ud800a\udc00",
  "\udc00\ud800",
  "\ud800\ud800\udc00\udc00",
  "\0\r\n\ufeffé\u07ff\u0800\uffff",
  "a\ud800😀\udc00z",
];

test("byte truncation preserves every numeric, direction and UTF-16 boundary", () => {
  for (const content of TEXTS) {
    for (const suffix of ["", "!", "中文😀", "\ud800", "\udc00"]) {
      for (const maxBytes of BUDGETS) {
        for (const direction of DIRECTIONS) {
          assert.equal(
            fitContentWithSuffix(content, maxBytes, suffix, direction),
            legacyFitContentWithSuffix(content, maxBytes, suffix, direction),
            JSON.stringify({ content, suffix, maxBytes: String(maxBytes), direction }),
          );
        }
      }
    }
  }
});

test("byte truncation independently budgets suffix before cross-join surrogate pairing", () => {
  for (const direction of DIRECTIONS) {
    assert.equal(
      fitContentWithSuffix("x\ud800", 6, "\udc00", direction),
      direction === "tail" ? "\ud800\udc00" : "x\udc00",
    );
    assert.equal(fitContentWithSuffix("\ud800", 5, "\udc00", direction), "\udc00");
    assert.equal(fitContentWithSuffix("😀x😀", 4, "", direction), "😀");
    assert.equal(fitContentWithSuffix("x\ud800", 3, "", "tail"), "\ud800");
    assert.equal(fitContentWithSuffix("\udc00x", 3, "", "head"), "\udc00");
  }
});

test("byte truncation exhaustively preserves adjacent surrogate and UTF-8 width classes", () => {
  const units = ["a", "\u07ff", "中", "\ud800", "\udbff", "\udc00", "\udfff"];
  for (const first of units)
    for (const second of units)
      for (const third of units) {
        const content = `${first}${second}${third}`;
        for (const suffix of ["", "\ud800", "\udc00"])
          for (let maxBytes = 0; maxBytes <= 12; maxBytes += 0.5) {
            for (const direction of DIRECTIONS)
              assert.equal(
                fitContentWithSuffix(content, maxBytes, suffix, direction),
                legacyFitContentWithSuffix(content, maxBytes, suffix, direction),
              );
          }
      }
});

function randomSequence(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

test("byte truncation matches the frozen algorithm on deterministic UTF-16 mixtures", () => {
  const random = randomSequence(0x41bcdb14);
  const units = [
    0, 10, 13, 32, 65, 0x7f, 0x80, 0x7ff, 0x800, 0x4e2d, 0xd7ff, 0xd800, 0xdbff, 0xdc00, 0xdfff,
    0xe000, 0xffff,
  ];
  const text = (length: number) =>
    Array.from({ length }, () => String.fromCharCode(units[random() % units.length]!)).join("");
  for (let iteration = 0; iteration < 1_000; iteration += 1) {
    const content = text(random() % 90);
    const suffix = text(random() % 15);
    const maxBytes =
      iteration % 7 === 0
        ? BUDGETS[random() % BUDGETS.length]!
        : (random() % 120) + (random() % 4) / 4;
    for (const direction of DIRECTIONS) {
      assert.equal(
        fitContentWithSuffix(content, maxBytes, suffix, direction),
        legacyFitContentWithSuffix(content, maxBytes, suffix, direction),
        `seed=0x41bcdb14 iteration=${iteration} direction=${direction} budget=${maxBytes}`,
      );
    }
  }
});

test("hook append retains its suffix and structured block projection", () => {
  const image = Object.freeze({
    type: "image" as const,
    mediaType: "image/png",
    dataUrl: "data:image/png;base64,AA==",
  });
  for (const maxBytes of BUDGETS) {
    for (const direction of DIRECTIONS) {
      const content = "abc中文😀\ud800";
      const suffix = "\n\n<system-reminder>中文</system-reminder>";
      const result = appendHookToStringContent(content, suffix, maxBytes, direction);
      const fits = Buffer.byteLength(`${content}${suffix}`, "utf8") <= maxBytes;
      assert.deepEqual(result, {
        content: fits
          ? `${content}${suffix}`
          : legacyFitContentWithSuffix(content, maxBytes, suffix, direction),
        truncated: !fits,
      });
      const modelContent = [image, Object.freeze({ type: "text" as const, text: content })];
      const projected = projectHookAugmentedModelContent({
        artifactPreview: false,
        contentProjection: result,
        hookContext: "context",
        maxModelBytes: maxBytes,
        modelContent,
        previewDirection: direction,
        suffix,
      });
      assert.ok(Array.isArray(projected));
      assert.strictEqual(projected[0], image);
      assert.deepEqual(
        projected,
        result.truncated
          ? [
              image,
              ...(legacyFitContentWithSuffix(content, maxBytes, suffix, direction)
                ? [
                    {
                      type: "text",
                      text: legacyFitContentWithSuffix(content, maxBytes, suffix, direction),
                    },
                  ]
                : []),
            ]
          : [...modelContent, { type: "text", text: "context" }],
      );
    }
  }
});

test("serialization still counts full originalBytes and returns the unchanged truncation envelope", async () => {
  const output = "a中文😀\ud800".repeat(500);
  const maxModelBytes = 200;
  const originalBytes = Buffer.byteLength(output, "utf8");
  for (const direction of DIRECTIONS) {
    const entry: ToolEntry = {
      capability: "Synthetic result budget fixture",
      metadata: {
        name: "PerformanceFixture",
        readOnly: true,
        destructive: false,
        concurrentSafe: true,
        sideEffectScope: "none",
        riskLevel: "low",
        needsApproval: false,
      },
      inputSchema: {},
      outputSchema: {},
      handler: async () => output,
      permission: {
        permission: "read",
        reason: "Synthetic fixture",
        riskLevel: "low",
        sideEffectScope: "none",
        needsApproval: false,
        patternSources: ["none"],
        denyPriority: "beforeAsk",
      },
      timeout: { kind: "none" },
      cancellation: {
        supported: false,
        cleanup: "none",
        userVisibleMessage: "Synthetic fixture cancelled",
      },
      trace: {
        required: true,
        propagateToAdapters: false,
        recordInput: "none",
        recordOutput: "none",
      },
      resultBudget: {
        strategy: "truncate",
        maxInlineBytes: maxModelBytes,
        maxModelBytes,
        preview: { direction },
      },
    };
    const result = await serializeOutput(
      {} as ToolExecutorDeps,
      output,
      entry,
      {} as TraceContext,
      "tool_fixture",
      new AbortController().signal,
    );
    const suffix = `\n\n[Tool output truncated by resultBudget: originalBytes=${originalBytes}, maxModelBytes=${maxModelBytes}, strategy=truncate]`;
    const content = legacyFitContentWithSuffix(output, maxModelBytes, suffix, direction);
    assert.deepEqual(result, {
      content,
      modelContent: content,
      originalBytes,
      returnedBytes: Buffer.byteLength(content, "utf8"),
      truncated: true,
      budgetStrategy: "truncate",
      artifactPath: undefined,
    });
  }
});

test("serialization preserves structured media references and complete text byte accounting", async () => {
  const image = Object.freeze({
    type: "image" as const,
    mediaType: "image/png",
    dataUrl: "data:image/png;base64,AA==",
  });
  const blocks = Object.freeze([image, Object.freeze({ type: "text" as const, text: "原文😀" })]);
  const entry: ToolEntry = {
    capability: "Synthetic media fixture",
    metadata: {
      name: "PerformanceMediaFixture",
      readOnly: true,
      destructive: false,
      concurrentSafe: true,
      sideEffectScope: "none",
      riskLevel: "low",
      needsApproval: false,
    },
    inputSchema: {},
    outputSchema: {},
    handler: async () => blocks,
    formatModelContent: () => blocks as unknown as ModelMessageContent,
    permission: {
      permission: "read",
      reason: "Synthetic fixture",
      riskLevel: "low",
      sideEffectScope: "none",
      needsApproval: false,
      patternSources: ["none"],
      denyPriority: "beforeAsk",
    },
    timeout: { kind: "none" },
    cancellation: {
      supported: false,
      cleanup: "none",
      userVisibleMessage: "Synthetic fixture cancelled",
    },
    trace: {
      required: true,
      propagateToAdapters: false,
      recordInput: "none",
      recordOutput: "none",
    },
    resultBudget: { strategy: "truncate", maxInlineBytes: Infinity, maxModelBytes: Infinity },
  };
  const result = await serializeOutput(
    {} as ToolExecutorDeps,
    blocks,
    entry,
    {} as TraceContext,
    "tool_media_fixture",
    new AbortController().signal,
  );
  assert.strictEqual(result.modelContent, blocks);
  assert.equal(result.originalBytes, Buffer.byteLength(result.content, "utf8"));
  assert.equal(result.returnedBytes, result.originalBytes);
  assert.equal(result.truncated, false);
  assert.deepEqual(blocks, [image, { type: "text", text: "原文😀" }]);
});

interface TruncationWork {
  expandedCodePoints: number;
  byteMeasuredCodeUnits: number;
  charCodeReads: number;
}

function measureTruncationWork(
  content: string,
  run: () => string,
): { result: string; work: TruncationWork } {
  const work: TruncationWork = {
    expandedCodePoints: 0,
    byteMeasuredCodeUnits: 0,
    charCodeReads: 0,
  };
  const from = Array.from;
  const byteLength = Buffer.byteLength;
  const charCodeAt = String.prototype.charCodeAt;
  Array.from = function (this: ArrayConstructor, input: unknown, ...rest: unknown[]) {
    const result = Reflect.apply(from, this, [input, ...rest]);
    if (input === content) work.expandedCodePoints += result.length;
    return result;
  } as typeof Array.from;
  Buffer.byteLength = function (value, encoding) {
    if (typeof value === "string") work.byteMeasuredCodeUnits += value.length;
    return byteLength(value, encoding);
  };
  String.prototype.charCodeAt = function (index) {
    if (String(this) === content) work.charCodeReads += 1;
    return charCodeAt.call(this, index);
  };
  try {
    return { result: run(), work };
  } finally {
    Array.from = from;
    Buffer.byteLength = byteLength;
    String.prototype.charCodeAt = charCodeAt;
  }
}

test("work budget: oversized byte truncation never expands the complete code-point array", (context) => {
  const content = "a".repeat(2_000_000);
  const maxBytes = 4_096;
  const measured = measureTruncationWork(content, () =>
    fitContentWithSuffix(content, maxBytes, "", "head"),
  );
  assert.equal(measured.result, "a".repeat(maxBytes));
  context.diagnostic(JSON.stringify({ codeUnits: content.length, maxBytes, ...measured.work }));
  assert.deepEqual(measured.work, {
    expandedCodePoints: 0,
    byteMeasuredCodeUnits: 0,
    charCodeReads: maxBytes + 1,
  });
});

test("work budget: fitting text retains the native bounded byte-length fast path", () => {
  const content = "a".repeat(49_990);
  const measured = measureTruncationWork(content, () =>
    fitContentWithSuffix(content, 50_000, "", "head"),
  );
  assert.equal(measured.result, content);
  assert.deepEqual(measured.work, {
    expandedCodePoints: 0,
    byteMeasuredCodeUnits: content.length,
    charCodeReads: 0,
  });
});

test("work budget: byte truncation inspects only the head or tail budget boundary", (context) => {
  const maxBytes = 4_096;
  for (const content of ["a".repeat(2_000_000), "中文😀\ud800".repeat(200_000)]) {
    for (const direction of DIRECTIONS) {
      const expected = legacyFitContentWithSuffix(content, maxBytes, " [cut]", direction);
      const measured = measureTruncationWork(content, () =>
        fitContentWithSuffix(content, maxBytes, " [cut]", direction),
      );
      assert.equal(measured.result, expected);
      const total =
        measured.work.expandedCodePoints +
        measured.work.byteMeasuredCodeUnits +
        measured.work.charCodeReads;
      context.diagnostic(
        JSON.stringify({ codeUnits: content.length, direction, maxBytes, ...measured.work, total }),
      );
      assert.ok(total <= maxBytes * 2 + 16, JSON.stringify({ direction, ...measured.work, total }));
    }
  }
});

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

const BENCHMARK_ENABLED = process.execArgv.includes("--test-name-pattern=benchmark");

test(
  "benchmark: alternating frozen and current byte truncation",
  { skip: !BENCHMARK_ENABLED },
  (context) => {
    let checksum = 0;
    for (const fixture of [
      { name: "small-ascii", text: "a".repeat(1_024), budget: 20_000, repetitions: 200 },
      { name: "1MiB-ascii", text: "a".repeat(1_048_576), budget: 20_000, repetitions: 3 },
      { name: "4MiB-ascii", text: "a".repeat(4_194_304), budget: 50_000, repetitions: 1 },
      {
        name: "unicode-600k-units",
        text: "a中文😀\ud800".repeat(100_000),
        budget: 50_000,
        repetitions: 2,
      },
    ]) {
      for (const direction of DIRECTIONS) {
        const args = [fixture.text, fixture.budget, " [cut]", direction] as const;
        assert.equal(fitContentWithSuffix(...args), legacyFitContentWithSuffix(...args));
        const sample = (run: typeof fitContentWithSuffix) => {
          const started = performance.now();
          for (let repetition = 0; repetition < fixture.repetitions; repetition += 1)
            checksum ^= run(...args).length;
          return (performance.now() - started) / fixture.repetitions;
        };
        for (let warmup = 0; warmup < 4; warmup += 1) {
          sample(legacyFitContentWithSuffix);
          sample(fitContentWithSuffix);
        }
        const oldMs: number[] = [];
        const currentMs: number[] = [];
        for (let iteration = 0; iteration < 15; iteration += 1) {
          if (iteration % 2 === 0) {
            oldMs.push(sample(legacyFitContentWithSuffix));
            currentMs.push(sample(fitContentWithSuffix));
          } else {
            currentMs.push(sample(fitContentWithSuffix));
            oldMs.push(sample(legacyFitContentWithSuffix));
          }
        }
        const oldWork = measureTruncationWork(fixture.text, () =>
          legacyFitContentWithSuffix(...args),
        ).work;
        const currentWork = measureTruncationWork(fixture.text, () =>
          fitContentWithSuffix(...args),
        ).work;
        context.diagnostic(
          JSON.stringify({
            node: process.version,
            fixture: fixture.name,
            codeUnits: fixture.text.length,
            budget: fixture.budget,
            direction,
            repetitions: fixture.repetitions,
            oldMedianMs: median(oldMs),
            currentMedianMs: median(currentMs),
            oldMs,
            currentMs,
            oldWork,
            currentWork,
          }),
        );
      }
    }
    assert.equal(typeof checksum, "number");
  },
);
