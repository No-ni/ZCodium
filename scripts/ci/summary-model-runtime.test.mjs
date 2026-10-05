import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { tsImport } from "tsx/esm/api";
import { modelConfig } from "./fixtures/local-model-config.mjs";

const {
  generateTitleCandidate,
  scheduleProjectMemoryExtraction,
  runMemoryAgentLoop,
  getCurrentModelInvocationContext,
} = await tsImport("./fixtures/summary-model-runtime.ts", import.meta.url);
const traceContext = { traceId: "fixture-trace", spanId: "fixture-span" };
const sessionSelection = { providerId: "session", modelId: "current" };

async function* streamOf(events) {
  yield* events;
}

function fakeModel(
  selection,
  requests,
  nextEvents,
  options = { reasoningLevel: "high", ...selection.options },
) {
  return {
    ...selection,
    properties: modelConfig.properties,
    optionSpecs: {
      ...modelConfig.optionSpecs,
      reasoningLevel: { values: ["disabled", "low", "high"], map: "{}" },
    },
    options,
    bind(patch) {
      return fakeModel(selection, requests, nextEvents, { ...options, ...patch });
    },
    generateText() {
      throw new Error("Auxiliary requests must stream");
    },
    streamText(request) {
      requests.push({
        selection,
        request,
        options: { ...options, ...request.options },
        invocation: getCurrentModelInvocationContext(),
      });
      return streamOf(nextEvents());
    },
  };
}

function titleRuntime(resolvePreference) {
  const requests = [];
  const selections = [];
  const runtime = {
    config: { taskType: "interactive", titleGeneration: {} },
    resolveSummaryModelSelection: resolvePreference,
    getSessionModelSelection: () => sessionSelection,
    modelFactory({ selection }) {
      selections.push(selection);
      if (
        selection.providerId === "removed" ||
        (selection.options?.reasoningLevel &&
          !["disabled", "low", "high"].includes(selection.options.reasoningLevel))
      )
        throw new Error("fixture-private-provider-error");
      return fakeModel(selection, requests, () => [
        { type: "text_delta", text: '{"title":"修复' },
        { type: "text_delta", text: '模型选择"}' },
        { type: "finish", finishReason: "stop", usage: {} },
      ]);
    },
    createEvent: (type, payload) => ({ type, payload }),
    appendEvent: async () => {},
    createModelStatusSink: () => () => {},
    extractToolCallsFromResult: (result) => result.toolCalls ?? [],
  };
  return { runtime, requests, selections };
}

test("title generation falls back after a deleted summary provider and after Host failure", async () => {
  for (const resolvePreference of [
    async () => ({ providerId: "removed", modelId: "deleted" }),
    async () => ({ providerId: "summary", modelId: "fixed", options: { reasoningLevel: "stale" } }),
    async () => {
      throw new Error("Host unavailable");
    },
  ]) {
    const { runtime, requests } = titleRuntime(resolvePreference);
    const result = await generateTitleCandidate.call(runtime, "Repair summary model selection", {
      querySource: "session_title",
      traceContext,
    });
    assert.equal(result.title, "修复模型选择");
    assert.deepEqual(result.modelSelection, sessionSelection);
    assert.equal(requests[0].selection.providerId, "session");
    assert.equal(requests[0].invocation.modelCall.operation, "session_title_generation");
    assert.equal(requests[0].options.reasoningLevel, "disabled");
  }
});

test("title requests honor changed summary reasoning while default titles stay at the lowest level", async () => {
  let preference;
  const { runtime, requests } = titleRuntime(async () => preference);
  for (const querySource of ["session_title", "goal_summary_title"]) {
    for (const reasoningLevel of ["high", "low", "disabled", undefined]) {
      preference = reasoningLevel
        ? { providerId: "summary", modelId: "fixed", options: { reasoningLevel } }
        : null;
      await generateTitleCandidate.call(runtime, "Repair summary model selection", {
        querySource,
        traceContext,
      });
      const request = requests.at(-1);
      assert.equal(request.options.reasoningLevel, reasoningLevel ?? "disabled");
      assert.equal(
        request.invocation.modelCall.reasoning.requestedLevel,
        reasoningLevel ?? "disabled",
      );
      assert.equal(request.options.maxOutputTokens, modelConfig.optionSpecs.maxOutputTokens.max);
    }
  }
});

test("the same Runtime reads changed and cleared preferences on each title task", async () => {
  let preference = { providerId: "summary", modelId: "first" };
  const { runtime, requests } = titleRuntime(async () => preference);
  runtime.config.titleGeneration.modelSelection = { providerId: "title", modelId: "legacy" };
  for (const selection of [preference, { providerId: "summary", modelId: "second" }, null]) {
    preference = selection;
    const result = await generateTitleCandidate.call(runtime, "Repair summary model selection", {
      querySource: "goal_summary_title",
      traceContext,
    });
    assert.equal(result.title, "修复模型选择");
    assert.equal(requests.at(-1).selection.modelId, selection?.modelId ?? "legacy");
    assert.equal(requests.at(-1).invocation.modelCall.operation, "goal_title_generation");
  }
});

test("default and invalid summary preferences preserve the memory snapshot invocation context", async () => {
  for (const preference of [
    undefined,
    { providerId: "removed", modelId: "deleted" },
    { providerId: "summary", modelId: "fixed", options: { reasoningLevel: "stale" } },
    { providerId: "summary", modelId: "fixed", options: { reasoningLevel: "high" } },
  ]) {
    const { runtime, requests } = titleRuntime(async () => preference);
    const model = fakeModel(sessionSelection, requests, () => [
      { type: "finish", finishReason: "stop", usage: {} },
    ]);
    let acquisition;
    Object.assign(runtime, {
      config: {
        taskType: "interactive",
        memory: { enabled: true, cliStorageRoot: resolve("fixture-storage") },
      },
      workspaceRoot: resolve("fixture-workspace"),
      workingDirectory: resolve("fixture-workspace"),
      messageHistory: { borrowReadOnlyRuntimeEntries: () => [] },
      readFileState: new Map(),
      getTools: () => [],
      latestConversationMessageId: "msg_fixture",
      isRemoteWorkspace: () => false,
      sessionStore: {
        messages: async () => [{ info: { id: "msg_fixture", role: "user" }, parts: [] }],
        getSession: async () => undefined,
      },
      fileSystemPort: {},
      memoryExtractionScheduler: {
        schedule(snapshot) {
          acquisition = snapshot;
        },
      },
    });
    scheduleProjectMemoryExtraction(runtime, { model, traceContext });
    const snapshot = await acquisition;
    await Array.fromAsync(snapshot.model.streamText({ messages: [] }));
    assert.equal(requests.at(-1).invocation.modelCall.operation, "project_memory_extract");
    assert.equal(requests.at(-1).invocation.metadata.querySource, "project_memory_extract");
    assert.equal(requests.at(-1).invocation.modelRequestSessionType, "other");
    assert.equal(
      requests.at(-1).selection.providerId,
      preference?.options?.reasoningLevel === "high" ? "summary" : "session",
    );
    runtime.resolveSummaryModelSelection = async () => ({
      providerId: "summary",
      modelId: "fixed",
      options: { reasoningLevel: "low" },
    });
    scheduleProjectMemoryExtraction(runtime, { model, traceContext });
    assert.equal((await acquisition).reasoningLevel, "low");
    runtime.resolveSummaryModelSelection = async () => null;
    scheduleProjectMemoryExtraction(runtime, { model, traceContext });
    assert.equal((await acquisition).reasoningLevel, undefined);
    // 后续偏好改变与清除不能改写已调度的高档或缺省快照。
    requests.length = 0;
    await runMemoryAgentLoop({
      messages: [],
      model: snapshot.model,
      reasoningLevel: snapshot.reasoningLevel,
      tools: [],
      maxTurns: 1,
      rootDir: snapshot.memoryRoot,
      workingDirectory: snapshot.workingDirectory,
      workspaceRoot: snapshot.workspaceRoot,
      executeTool: async () => {
        throw new Error("No tools expected");
      },
    });
    assert.equal(
      requests[0].options.reasoningLevel,
      preference?.options?.reasoningLevel === "high" ? "high" : "disabled",
    );
    assert.equal(requests[0].options.maxOutputTokens, modelConfig.optionSpecs.maxOutputTokens.max);
  }
});

test("memory streaming completes a tool round and replays signed reasoning", async () => {
  const requests = [];
  const toolCall = { id: "fixture-call", name: "Read", input: { file_path: "fixture.md" } };
  const providerMetadata = { anthropic: { signature: "fixture-signature" } };
  let round = 0;
  const model = fakeModel(sessionSelection, requests, () =>
    round++ === 0
      ? [
          { type: "reasoning_start", id: "r" },
          { type: "reasoning_delta", id: "r", text: "thinking" },
          { type: "reasoning_end", id: "r", providerMetadata },
          { type: "tool_call", toolCall },
          { type: "finish", finishReason: "tool_calls", usage: {} },
        ]
      : [
          { type: "text_delta", text: "Nothing to save." },
          { type: "finish", finishReason: "stop", usage: {} },
        ],
  );
  const executed = [];
  const result = await runMemoryAgentLoop({
    messages: [],
    model,
    reasoningLevel: "high",
    tools: [{ name: "Read" }],
    maxTurns: 5,
    rootDir: resolve("fixture-memory"),
    workingDirectory: resolve("fixture-workspace"),
    workspaceRoot: resolve("fixture-workspace"),
    executeTool: async (call) => {
      executed.push(call);
      return { content: "fixture", metadata: {} };
    },
  });
  assert.equal(result.turns, 2);
  assert.deepEqual(
    requests.map((request) => request.options.reasoningLevel),
    ["high", "high"],
  );
  assert.deepEqual(executed, [toolCall]);
  assert.deepEqual(requests[1].request.messages[0].content[0], {
    type: "reasoning",
    text: "thinking",
    providerOptions: providerMetadata,
  });
  assert.equal(requests[1].request.messages[1].role, "tool");
});

test("an incomplete memory stream never executes collected tool calls", async () => {
  const model = fakeModel(sessionSelection, [], () => [
    { type: "tool_call", toolCall: { id: "fixture-call", name: "Read", input: {} } },
  ]);
  let executions = 0;
  await assert.rejects(
    runMemoryAgentLoop({
      messages: [],
      model,
      tools: [{ name: "Read" }],
      maxTurns: 1,
      rootDir: resolve("fixture-memory"),
      workingDirectory: resolve("fixture-workspace"),
      workspaceRoot: resolve("fixture-workspace"),
      executeTool: async () => {
        executions++;
        return {};
      },
    }),
    /Model stream.*finish/,
  );
  assert.equal(executions, 0);
});
