import assert from "node:assert/strict";
import test from "node:test";
import { type MessageWithParts, type Model } from "@zcode/contracts";
import { createMessageHistory } from "../src/agent/message-history.js";
import { hydrateMessageHistoryFromSession } from "../src/agent/session-history-hydrator.js";
import { buildToolExposure } from "../src/tool/search/exposure.js";
import { collectDiscoveredTools } from "../src/tool/search/history.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { toolSearchToolEntry } from "../src/tool/handlers/tool-search.js";
import { deferredToolCallEntry } from "../src/tool/handlers/deferred-tool-call.js";
import { completedToolPartMetadata } from "../src/runtime/methods/tool-part-metadata.js";
import { buildCompactSummaryRequestMessages } from "../src/runtime/methods/compact-active-helpers.js";
import { runCompactSummaryModelRequest } from "../src/runtime/methods/compact-summary-model-request.js";
import { compactActiveConversation } from "../src/runtime/methods/compact-active.js";
import { buildRuntimeProviderRequestMessages } from "../src/runtime/helpers/runtime-provider-request-messages.js";
import { maybeLocalMicrocompactMessages } from "../src/compact/microcompact.js";

const NAME = "FixtureLookup";
const reference = { type: "tool_reference" as const, toolName: NAME };
const model = {
  properties: { supportsToolCall: true, inputFormat: {}, contextWindow: 128_000 },
  providerId: "fixture-provider",
  modelId: "fixture-model",
  optionSpecs: { maxOutputTokens: { max: 1024 }, reasoningLevel: { values: ["off"] } },
  options: {},
} as unknown as Model;
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
const info = (id: string, role: "user" | "assistant") =>
  role === "user"
    ? { id, role, sessionID: "fixture-session", time: { created: 1 }, agent: "fixture" }
    : {
        id,
        role,
        sessionID: "fixture-session",
        time: { created: 1 },
        agent: "fixture",
        parentID: "prompt",
        mode: "build",
        path: { cwd: "/fixture", root: "/fixture" },
        cost: 0,
        tokens,
      };
const prompt = (): MessageWithParts =>
  ({
    info: info("prompt", "user"),
    parts: [
      {
        type: "text",
        id: "prompt-text",
        messageID: "prompt",
        sessionID: "fixture-session",
        text: "fixture",
      },
    ],
  }) as any;
function toolMessage(id: string, name: string, signature?: string): MessageWithParts {
  return {
    info: info(id, "assistant"),
    parts: [
      {
        type: "tool",
        id: `${id}-part`,
        callID: `${id}-call`,
        messageID: id,
        sessionID: "fixture-session",
        tool: name,
        metadata: signature
          ? {
              modelCallWrapper: "DeferredToolCall",
              providerOptions: { google: { thoughtSignature: signature } },
            }
          : {},
        state: {
          status: "completed",
          input: name === "ToolSearch" ? { query: `select:${NAME}` } : { value: id },
          output: "fixture-result",
          title: name,
          metadata: name === "ToolSearch" ? { toolSearchContent: [reference] } : {},
          time: { start: 1, end: 2 },
        },
      },
    ],
  } as any;
}
function catalog() {
  const registry = createToolRegistry();
  registry.register(toolSearchToolEntry);
  registry.register(deferredToolCallEntry);
  registry.register({
    ...toolSearchToolEntry,
    metadata: { ...toolSearchToolEntry.metadata, name: NAME, alwaysLoad: false, shouldDefer: true },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { value: { type: "string" } },
    },
  });
  return registry;
}

test("cold hydration restores successful references and every wrapped Gemini call independently", async () => {
  const history = createMessageHistory();
  const messages = [
    prompt(),
    toolMessage("search", "ToolSearch"),
    toolMessage("first", NAME, "signature-one"),
    toolMessage("second", NAME, "signature-two"),
  ];
  await hydrateMessageHistoryFromSession({ history, messages });
  const entries = history.toRuntimeEntries();
  assert.deepEqual([...collectDiscoveredTools(entries)], [NAME]);
  const calls = entries.flatMap((entry) =>
    entry.kind === "attachment" ? [] : (entry.message.toolCalls ?? []),
  );
  assert.deepEqual(
    calls.slice(1).map((call) => ({
      name: call.name,
      input: call.input,
      marker: call.modelCallWrapper,
      options: call.providerOptions,
    })),
    [
      {
        name: NAME,
        input: { value: "first" },
        marker: "DeferredToolCall",
        options: { google: { thoughtSignature: "signature-one" } },
      },
      {
        name: NAME,
        input: { value: "second" },
        marker: "DeferredToolCall",
        options: { google: { thoughtSignature: "signature-two" } },
      },
    ],
  );
  const registry = catalog();
  const local = buildToolExposure({
    model,
    mode: "local",
    entries,
    tools: registry.toContracts(),
    registry,
  });
  assert.ok(
    local.entries.some(
      (entry) =>
        entry.kind !== "attachment" &&
        Array.isArray(entry.message.content) &&
        entry.message.content.some(
          (block) => block.type === "text" && block.text.includes("<functions>"),
        ),
    ),
  );
  assert.deepEqual(messages[1]!.parts[0]!.state.metadata.toolSearchContent, [reference]);
});

test("kept branch/fork restores only retained search facts; failed and malformed metadata grant no discovery", async () => {
  const messages = [
    prompt(),
    toolMessage("search", "ToolSearch"),
    toolMessage("kept", NAME, "kept-signature"),
    toolMessage("new", NAME, "new-signature"),
  ];
  const history = createMessageHistory();
  await hydrateMessageHistoryFromSession({
    history,
    messages,
    branchCutAfterMessageId: "kept" as any,
    rewindTargetMessageId: "search" as any,
    rewindKeptMessageIds: ["prompt" as any, "kept" as any],
  });
  assert.deepEqual([...collectDiscoveredTools(history.toRuntimeEntries())], []);
  const fork = createMessageHistory();
  await hydrateMessageHistoryFromSession({ history: fork, messages: messages.slice(0, 2) });
  assert.deepEqual([...collectDiscoveredTools(fork.toRuntimeEntries())], [NAME]);
  const invalid = toolMessage("invalid", "ToolSearch");
  (invalid.parts[0] as any).state.metadata.toolSearchContent = [{ ...reference, grant: true }];
  const failed = toolMessage("failed", "ToolSearch");
  (failed.parts[0] as any).state = {
    status: "error",
    input: {},
    error: "cancelled",
    metadata: { toolSearchContent: [reference] },
    time: { start: 1, end: 2 },
  };
  const invalidHistory = createMessageHistory();
  await hydrateMessageHistoryFromSession({
    history: invalidHistory,
    messages: [prompt(), invalid, failed],
  });
  assert.equal(collectDiscoveredTools(invalidHistory.toRuntimeEntries()).size, 0);
});

test("compact summary and announcement metadata hydrate and cannot resurrect unavailable tools", async () => {
  const summary = {
    info: info("summary", "user"),
    parts: [
      {
        type: "text",
        id: "summary-text",
        messageID: "summary",
        sessionID: "fixture-session",
        synthetic: true,
        text: "fixture summary",
      },
      {
        type: "compaction",
        id: "summary-boundary",
        messageID: "summary",
        sessionID: "fixture-session",
        compactBoundary: { boundaryId: "fixture-boundary", preCompactDiscoveredTools: [NAME] },
      },
    ],
  } as unknown as MessageWithParts;
  const announcement = {
    info: info("announcement", "user"),
    parts: [
      {
        type: "text",
        id: "announcement-text",
        messageID: "announcement",
        sessionID: "fixture-session",
        synthetic: true,
        text: "fixture catalog",
        metadata: {
          runtimeMessage: {
            source: "tool_search_announcement",
            toolSearchAnnouncement: { addedNames: [NAME], removedNames: [], readdedNames: [] },
          },
        },
      },
    ],
  } as unknown as MessageWithParts;
  const history = createMessageHistory();
  await hydrateMessageHistoryFromSession({ history, messages: [prompt(), summary, announcement] });
  assert.deepEqual([...collectDiscoveredTools(history.toRuntimeEntries())], [NAME]);
  assert.deepEqual(history.toRuntimeEntries().at(-1)!.metadata!.toolSearchAnnouncement, {
    addedNames: [NAME],
    removedNames: [],
    readdedNames: [],
  });
  const registry = catalog();
  const exposure = buildToolExposure({
    model,
    mode: "local",
    entries: history.toRuntimeEntries(),
    tools: registry.toContracts(),
    registry,
  });
  assert.ok(exposure.tools.some((tool) => tool.name === NAME));
  registry.unregister(NAME);
  const removed = buildToolExposure({
    model,
    mode: "local",
    entries: history.toRuntimeEntries(),
    tools: registry.toContracts(),
    registry,
  });
  assert.ok(!removed.tools.some((tool) => tool.name === NAME));
});

test("completed result metadata persists references but errors cannot create discovery", () => {
  const result = { toolName: "ToolSearch", success: true, modelContent: [reference] } as any;
  assert.deepEqual(completedToolPartMetadata(result).toolSearchContent, [reference]);
  assert.equal(
    completedToolPartMetadata({ ...result, success: false }).toolSearchContent,
    undefined,
  );
});

test("auxiliary and compact projections strip native references on copies, never canonical calls/signatures", async () => {
  const history = createMessageHistory();
  await hydrateMessageHistoryFromSession({
    history,
    messages: [
      prompt(),
      toolMessage("search", "ToolSearch"),
      toolMessage("wrapped", NAME, "fixture-signature"),
    ],
  });
  const entries = history.toRuntimeEntries();
  for (const messages of [
    buildCompactSummaryRequestMessages(entries, "summary"),
    buildRuntimeProviderRequestMessages({ config: {} }, { model, entries }).messages,
  ]) {
    assert.ok(!JSON.stringify(messages).includes('"type":"tool_reference"'));
    assert.ok(JSON.stringify(messages).includes("fixture-signature"));
  }
  assert.deepEqual([...collectDiscoveredTools(entries)], [NAME]);
  const seen: any[] = [];
  const summaryModel = {
    ...model,
    streamText: async function* (request: any) {
      seen.push(request);
      yield* [];
      throw new Error("fixture fallback");
    },
    generateText: async (request: any) => {
      seen.push(request);
      return { text: "summary", finishReason: "stop", usage: {} };
    },
  } as Model;
  await runCompactSummaryModelRequest({
    model: summaryModel,
    request: {
      messages: buildCompactSummaryRequestMessages(entries, "summary"),
      tools: catalog().toContracts(),
      traceContext: { traceId: "fixture" } as any,
    },
  });
  assert.equal(seen.length, 2);
  for (const request of seen) {
    assert.deepEqual(request.tools, []);
    assert.equal(request.toolSearchEnabled, false);
  }
});

test("microcompact never clears successful discovery references even with custom compactable tools", () => {
  const messages = Array.from({ length: 4 }, (_, index) => [
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: `search-${index}`, name: "ToolSearch", input: {} }],
    },
    {
      role: "tool",
      toolName: "ToolSearch",
      toolCallId: `search-${index}`,
      content: [{ type: "text" as const, text: "fixture".repeat(1000) }, reference],
    },
  ]).flat();
  const compacted = maybeLocalMicrocompactMessages({
    messages,
    config: {
      enabled: true,
      thresholdTokens: 1,
      minTokenSavings: 0,
      compactableToolNames: ["ToolSearch"],
      keepRecentToolResults: 1,
    },
  });
  assert.equal(compacted.payload, undefined);
  assert.equal(compacted.messages.filter((message) => Array.isArray(message.content)).length, 4);
});

test("actual compact pipeline persists discovered metadata and always makes a no-tool summary request", async () => {
  const history = createMessageHistory();
  history.addUser("fixture");
  history.addAssistant("", [{ id: "search", name: "ToolSearch", input: {} }]);
  history.addToolResult("search", "ToolSearch", [reference], true);
  history.addAssistant("fixture completion");
  const requests: any[] = [];
  const persisted: any[] = [];
  const events: any[] = [];
  const summaryModel = {
    ...model,
    streamText: async function* (request: any) {
      requests.push(request);
      yield { type: "text_delta", text: "fixture summary" };
      yield { type: "text_end" };
      yield { type: "finish", finishReason: "stop", usage: {} };
    },
  } as Model;
  const runtime = {
    config: { toolSearch: { mode: "local" } },
    sessionId: "fixture-session",
    workingDirectory: "/fixture",
    workspaceRoot: "/fixture",
    latestConversationMessageId: "fixture-last",
    readFileState: new Map(),
    messageHistory: history,
    getTools: () => catalog().toContracts(),
    initializeMcp: async () => {},
    buildCompactTimelinePayload: (_timeline: any, update: any) => ({ ...update }),
    persistCompactTimeline: async () => {},
    createEvent: (type: any, payload: any) => ({ type, payload }),
    appendEvent: async (event: any) => {
      events.push(event);
    },
    createModelStatusSink: () => ({ emit: () => {} }),
    extractToolCallsFromResult: (result: any) => result.toolCalls ?? [],
    persistCompactSummary: async (...args: any[]) => {
      persisted.push(args);
    },
    finishCompactTimelineFailure: async () => {},
  } as any;
  const result = await compactActiveConversation.call(
    runtime,
    undefined,
    { traceId: "fixture-trace" } as any,
    [],
    { model: summaryModel },
  );
  assert.equal(result.outcome, "compacted");
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].tools, []);
  assert.equal(requests[0].toolSearchEnabled, false);
  assert.ok(!JSON.stringify(requests[0].messages).includes('"type":"tool_reference"'));
  assert.deepEqual(persisted[0][3].preCompactDiscoveredTools, [NAME]);
  assert.deepEqual([...collectDiscoveredTools(result.entries)], [NAME]);
  assert.deepEqual([...collectDiscoveredTools(history.toRuntimeEntries())], [NAME]);
});
