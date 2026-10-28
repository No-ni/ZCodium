import assert from "node:assert/strict";
import test from "node:test";
import { InMemorySessionEventStore, type Model, type ModelToolCall } from "@zcode/contracts";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import type { RunModelTextRequestOptions } from "../src/runtime/types.js";
import { runModelTextRequest } from "../src/runtime/methods/model.js";
import { createStreamingToolCoordinator } from "../src/runtime/methods/streaming-tool-coordinator.js";
import { scheduleTools, executeTools } from "../src/runtime/methods/tools.js";
import { buildToolExposure } from "../src/tool/search/exposure.js";
import { toolSearchToolEntry } from "../src/tool/handlers/tool-search.js";
import { ToolScheduler } from "../src/tool/scheduler.js";

const TARGET = "FixtureLookup";
const SIGNATURE = { google: { thoughtSignature: "fixture-signature" } };
const wrapper = (): ModelToolCall => ({
  id: "fixture-call",
  name: "DeferredToolCall",
  input: { name: TARGET, input: { value: "fixture" } },
  providerOptions: SIGNATURE,
});

function modelFixture(stream = false): Model {
  const model = {
    providerId: "fixture-provider",
    modelId: "fixture-model",
    options: {},
    properties: { supportsToolCall: true, inputFormat: {}, contextWindow: 128_000 },
    optionSpecs: { maxOutputTokens: { max: 1024 }, reasoningLevel: { values: ["off"] } },
    bind: () => model,
    generateText: async () => ({
      text: "",
      toolCalls: [wrapper()],
      usage: {},
      finishReason: "tool-calls",
    }),
    streamText: async function* () {
      if (!stream) return;
      yield { type: "tool_input_start", id: "fixture-call", toolName: "DeferredToolCall" };
      yield {
        type: "tool_input_delta",
        id: "fixture-call",
        delta: JSON.stringify(wrapper().input),
      };
      yield { type: "tool_input_end", id: "fixture-call" };
      yield { type: "tool_call", toolCall: wrapper() };
      yield { type: "finish", finishReason: "tool-calls", usage: {} };
    },
  } as unknown as Model;
  return model;
}

function runtimeFixture() {
  const model = modelFixture();
  const runtime = new AgentRuntime(
    "fixture-session" as any,
    {
      workingDirectory: "/fixture",
      toolSearch: { mode: "local" },
      modelStreaming: "on",
      memory: { enabled: false },
      subagents: { enabled: false },
    },
    { eventStore: new InMemorySessionEventStore(), modelFactory: () => model },
  ) as unknown as AgentRuntimeInternal;
  const seen: unknown[] = [];
  runtime.registry.register({
    ...toolSearchToolEntry,
    runtimeInputSchema: undefined,
    runtimeOutputSchema: undefined,
    inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    outputSchema: {},
    formatModelContent: undefined,
    metadata: {
      ...toolSearchToolEntry.metadata,
      name: TARGET,
      alwaysLoad: false,
      shouldDefer: true,
    },
    handler: async (input, context) => {
      seen.push({ input, callId: context.toolCallId });
      return { found: true };
    },
  });
  runtime.cachedTools = null;
  const exposure = buildToolExposure({
    model,
    mode: "local",
    tools: runtime.getTools(model),
    entries: [],
    registry: runtime.registry,
  });
  return { runtime, model, seen, exposure };
}

test("runtime control registration follows explicit modes and never widens an allowlist", () => {
  const { runtime, model } = runtimeFixture();
  runtime.updateConfig({ toolSearch: { mode: "off" } });
  assert.equal(runtime.registry.has("ToolSearch"), false);
  assert.equal(runtime.registry.has("DeferredToolCall"), false);
  runtime.updateConfig({ toolSearch: { mode: "auto" } });
  assert.equal(runtime.registry.has("ToolSearch"), true);
  assert.ok(runtime.getTools(model).some((tool) => tool.name === "DeferredToolCall"));
  runtime.config.toolAllowlist = ["Read"];
  runtime.updateConfig({ toolSearch: { mode: "local" } });
  assert.equal(runtime.registry.has("ToolSearch"), false);
  assert.equal(runtime.registry.has("DeferredToolCall"), false);
});

test("Off during an active request preserves its controls until the request boundary", async () => {
  const { runtime, model, exposure } = runtimeFixture();
  const active = runtime.beginActiveTurn(
    "fixture-turn" as any,
    { traceId: "fixture-trace" } as any,
    "regular",
    true,
  );
  runtime.updateConfig({ toolSearch: { mode: "off" } });
  assert.equal(runtime.getToolSearchMode(), "off");
  assert.ok(!runtime.getTools(model).some((tool) => tool.name === "ToolSearch"));
  assert.ok(
    runtime.registry.has("ToolSearch"),
    "in-flight request keeps its captured execution surface",
  );
  const result = await runtime.executor.execute(
    { id: "in-flight-search", name: "ToolSearch", input: { query: `select:${TARGET}` } },
    { toolSearch: exposure.context },
  );
  assert.equal(result.success, true);
  runtime.finishActiveTurn(active);
  assert.equal(runtime.registry.has("ToolSearch"), false);
  assert.equal(runtime.registry.has("DeferredToolCall"), false);
});

test("stream and nonstream model admission emit real target/input while retaining callId and every signature", async () => {
  for (const streaming of [false, true]) {
    const { runtime, exposure } = runtimeFixture();
    const emitted: any[] = [];
    const accepted: ModelToolCall[] = [];
    runtime.shouldStreamModelText = () => streaming;
    runtime.createModelStatusSink = () => ({ emit: () => {} }) as any;
    runtime.buildContextUsageSnapshot = () => ({}) as any;
    runtime.buildContextUsageBreakdownFromSnapshot = () => [];
    runtime.logContextUsageSnapshot = () => {};
    runtime.emitModelStreamingEvent = async (payload) => {
      emitted.push(payload);
    };
    const result = await runModelTextRequest.call(runtime, {
      assistantMessageId: "fixture-assistant",
      events: [],
      messages: [],
      tools: exposure.tools,
      toolSearch: exposure.context,
      toolSearchEnabled: false,
      model: modelFixture(streaming),
      traceContext: { traceId: "fixture-trace" },
      onStreamToolCall: (call) => accepted.push(call),
    } as RunModelTextRequestOptions);
    const call = result.toolCalls![0]!;
    assert.equal(call.name, TARGET);
    assert.deepEqual(call.input, { value: "fixture" });
    assert.equal(call.id, "fixture-call");
    assert.equal(call.modelCallWrapper, "DeferredToolCall");
    assert.deepEqual(call.providerOptions, SIGNATURE);
    if (streaming) {
      assert.equal(
        emitted.find((event) => event.kind === "tool_input_start").toolName,
        "DeferredToolCall",
      );
      assert.equal(emitted.find((event) => event.kind === "tool_call").toolName, TARGET);
      assert.deepEqual(emitted.find((event) => event.kind === "tool_call").input, {
        value: "fixture",
      });
      assert.deepEqual(accepted, [call]);
    }
  }
});

test("stream coordinator resolves before read-only scheduling and persists only real target/input plus wrapper/signature", async () => {
  const { runtime, model, exposure, seen } = runtimeFixture();
  const parts: any[] = [];
  const dependencies: any[] = [];
  const scheduler = new ToolScheduler();
  runtime.toolScheduler = {
    schedule: (input: any) => {
      dependencies.push(input);
      return scheduler.schedule(input);
    },
  } as any;
  runtime.persistPart = async (part) => {
    parts.push(part);
  };
  runtime.scheduleTools = scheduleTools.bind(runtime);
  runtime.executeTools = executeTools.bind(runtime);
  runtime.emitToolScheduledEvents = async () => [];
  const state = {
    model,
    turnAbortSignal: new AbortController().signal,
    events: [],
    turnTraceContext: {},
  } as any;
  const coordinator = createStreamingToolCoordinator(runtime, state, {
    assistantMessageId: "fixture-assistant" as any,
    model,
    traceContext: { traceId: "fixture-trace" } as any,
    toolSearch: exposure.context,
  });
  coordinator.accept(wrapper());
  const results = await coordinator.drain([wrapper()]);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.result.toolName, TARGET);
  assert.deepEqual(seen, [{ input: { value: "fixture" }, callId: "fixture-call" }]);
  assert.equal(dependencies[0][0].toolName, TARGET);
  assert.equal(dependencies[0][0].readOnly, true);
  assert.equal(dependencies[0][0].concurrentSafe, true);
  assert.equal(parts.length, 2);
  for (const part of parts) {
    assert.equal(part.tool, TARGET);
    assert.deepEqual(part.state.input, { value: "fixture" });
    assert.equal(part.metadata.modelCallWrapper, "DeferredToolCall");
    assert.deepEqual(part.metadata.providerOptions, SIGNATURE);
  }
});
