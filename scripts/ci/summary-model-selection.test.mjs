import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const { collectModelStreamResult } = await tsImport(
  "../../apps/zcode-cli/packages/core/src/model/collect-model-stream-result.ts",
  import.meta.url,
);

const { resolveSummaryModel, resolveSummaryModelSelection } = await tsImport(
  "../../apps/zcode-cli/packages/core/src/runtime/helpers/summary-model.ts",
  import.meta.url,
);

const { zcodeSessionRuntimePreferencesResultSchema } = await tsImport(
  "../../packages/shared/src/zcode-protocol/index.ts",
  import.meta.url,
);

const { appSettingsSchema, appSettingsPatchSchema } = await tsImport(
  "../../packages/shared/src/validationAppSettings.ts",
  import.meta.url,
);

function fakeRuntime(overrides = {}) {
  return {
    logger: {
      warn(message, context) {
        runtimeLogs.push({ message, context });
      },
    },
    resolveSummaryModelSelection: undefined,
    // createRuntimeModel 的 invocation 层读取 config.taskType 决定重试预算。
    config: { taskType: "interactive" },
    modelFactory: undefined,
    ...overrides,
  };
}

const runtimeLogs = [];

const traceContext = { traceId: "test-trace", spanId: "test-span" };

async function* streamOf(events) {
  for (const event of events) {
    yield event;
  }
}

test("collectModelStreamResult aggregates text, reasoning, tool calls and finish", async () => {
  const result = await collectModelStreamResult({
    events: streamOf([
      { type: "start" },
      { type: "reasoning_start", id: "r1" },
      { type: "reasoning_delta", id: "r1", text: "thinking " },
      { type: "reasoning_delta", id: "r1", text: "hard" },
      { type: "reasoning_end", id: "r1" },
      { type: "text_start", id: "t1" },
      { type: "text_delta", id: "t1", text: "Hello " },
      { type: "text_delta", id: "t1", text: "world" },
      { type: "text_end", id: "t1" },
      {
        type: "tool_call",
        toolCall: { id: "call-1", name: "Read", input: { file_path: "/tmp/a.md" } },
      },
      {
        type: "finish",
        finishReason: "tool_calls",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    ]),
  });

  assert.equal(result.text, "Hello world");
  assert.equal(result.finishReason, "tool_calls");
  assert.deepEqual(result.reasoning, [{ type: "reasoning", text: "thinking hard" }]);
  assert.equal(result.toolCalls?.length, 1);
  assert.equal(result.toolCalls?.[0]?.name, "Read");
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 5 });
});

test("collectModelStreamResult aggregates reasoning deltas without a start event", async () => {
  const result = await collectModelStreamResult({
    events: streamOf([
      { type: "reasoning_delta", text: "late" },
      { type: "text_delta", text: "body" },
      { type: "finish", finishReason: "stop", usage: {} },
    ]),
  });

  assert.equal(result.text, "body");
  // Anthropic-compatible providers may skip reasoning_start；默认块兜底保留。
  assert.deepEqual(result.reasoning, [{ type: "reasoning", text: "late" }]);
});

test("collectModelStreamResult surfaces stream errors", async () => {
  await assert.rejects(
    collectModelStreamResult({
      events: streamOf([
        { type: "text_delta", text: "partial" },
        { type: "error", error: new Error("gateway reset") },
      ]),
    }),
    /gateway reset/,
  );
});

test("resolveSummaryModelSelection returns host preference when present", async () => {
  const runtime = fakeRuntime({
    resolveSummaryModelSelection: async () => ({
      providerId: "p",
      modelId: "m",
    }),
  });
  const selection = await resolveSummaryModelSelection(runtime, {
    operation: "project_memory_extract",
    traceContext,
  });
  assert.deepEqual(selection, { providerId: "p", modelId: "m" });
});

test("resolveSummaryModelSelection falls back to undefined when host resolver is absent", async () => {
  const runtime = fakeRuntime();
  const selection = await resolveSummaryModelSelection(runtime, {
    operation: "project_memory_extract",
    traceContext,
  });
  assert.equal(selection, undefined);
  assert.equal(runtimeLogs.length, 0);
});

test("resolveSummaryModelSelection swallows host resolution failures", async () => {
  const runtime = fakeRuntime({
    resolveSummaryModelSelection: async () => {
      throw new Error("host timeout");
    },
  });
  const selection = await resolveSummaryModelSelection(runtime, {
    operation: "project_memory_extract",
    traceContext,
  });
  assert.equal(selection, undefined);
  assert.ok(runtimeLogs.some((entry) => entry.context?.reason === "host_resolution_failed"));
});

test("resolveSummaryModel prefers host selection over the turn model", async () => {
  const createdSelections = [];
  const runtime = fakeRuntime({
    resolveSummaryModelSelection: async () => ({
      providerId: "host",
      modelId: "preferred",
    }),
    modelFactory: ({ selection }) => {
      createdSelections.push(selection);
      return {
        providerId: selection.providerId,
        modelId: selection.modelId,
        generateText: async () => ({}),
        streamText: async function* () {},
      };
    },
  });
  const fallbackModel = {
    providerId: "turn",
    modelId: "model",
    generateText: async () => ({}),
    streamText: async function* () {},
  };

  const model = await resolveSummaryModel(runtime, {
    fallback: fallbackModel,
    operation: "project_memory_extract",
    traceContext,
  });

  assert.equal(model.providerId, "host");
  assert.equal(model.modelId, "preferred");
  assert.deepEqual(createdSelections, [{ providerId: "host", modelId: "preferred" }]);
});

test("resolveSummaryModel falls back to the turn model when selection creation fails", async () => {
  const runtime = fakeRuntime({
    resolveSummaryModelSelection: async () => ({
      providerId: "gone",
      modelId: "deleted",
    }),
    modelFactory: () => {
      throw new Error("provider removed");
    },
  });
  const fallbackModel = {
    providerId: "turn",
    modelId: "model",
    generateText: async () => ({}),
    streamText: async function* () {},
  };

  const model = await resolveSummaryModel(runtime, {
    fallback: fallbackModel,
    operation: "project_memory_extract",
    traceContext,
  });

  assert.equal(model, fallbackModel);
  assert.ok(runtimeLogs.some((entry) => entry.context?.reason === "model_creation_failed"));
});

test("runtime preferences schema accepts summaryModelSelection and stays old-host compatible", () => {
  const withSummary = zcodeSessionRuntimePreferencesResultSchema.parse({
    nativeSearchEnhancementsEnabled: true,
    memoryEnabled: true,
    askUserQuestionAutoResolutionEnabled: true,
    summaryModelSelection: { providerId: "p", modelId: "m" },
  });
  assert.deepEqual(withSummary.summaryModelSelection, { providerId: "p", modelId: "m" });

  // 旧 Host 不回该字段：解析成功且值为 nullish，core 按跟随会话模型处理。
  const legacy = zcodeSessionRuntimePreferencesResultSchema.parse({
    nativeSearchEnhancementsEnabled: true,
    memoryEnabled: false,
    askUserQuestionAutoResolutionEnabled: true,
  });
  assert.equal(legacy.summaryModelSelection == null, true);

  const cleared = zcodeSessionRuntimePreferencesResultSchema.parse({
    nativeSearchEnhancementsEnabled: true,
    memoryEnabled: true,
    askUserQuestionAutoResolutionEnabled: true,
    summaryModelSelection: null,
  });
  assert.equal(cleared.summaryModelSelection, null);
});

test("app settings schemas round-trip summaryModelSelection including null clears", () => {
  const parsed = appSettingsSchema.parse({
    summaryModelSelection: { providerId: "p", modelId: "m", options: { reasoningLevel: "high" } },
  });
  assert.deepEqual(parsed.summaryModelSelection, {
    providerId: "p",
    modelId: "m",
    options: { reasoningLevel: "high" },
  });

  const patch = appSettingsPatchSchema.parse({ summaryModelSelection: null });
  assert.equal(patch.summaryModelSelection, null);

  const withoutField = appSettingsSchema.parse({});
  assert.equal(withoutField.summaryModelSelection == null, true);
});
